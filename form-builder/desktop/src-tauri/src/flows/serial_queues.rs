//! Per-key serial execution queues (audit FL-002).
//!
//! The flow dispatcher must process every event of ONE phone call in arrival
//! order (`call.incoming` before `call.answered` before its transcript turns),
//! while events of DIFFERENT calls run concurrently. This primitive owns that
//! guarantee: `enqueue(key, item)` appends to the key's queue and a per-key
//! worker task drains it strictly sequentially through the handler; workers
//! retire after an idle window and are revived — without losing or reordering
//! items — on the next enqueue.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;

type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
pub type Handler<T> = Arc<dyn Fn(T) -> BoxFuture + Send + Sync>;

pub struct SerialQueues<T: Send + 'static> {
    handler: Handler<T>,
    idle: Duration,
    queues: Mutex<HashMap<String, mpsc::UnboundedSender<T>>>,
}

impl<T: Send + 'static> SerialQueues<T> {
    pub fn new(idle: Duration, handler: Handler<T>) -> Arc<Self> {
        Arc::new(SerialQueues {
            handler,
            idle,
            queues: Mutex::new(HashMap::new()),
        })
    }

    /// Append `item` to `key`'s queue, spawning (or reviving) the key's
    /// worker. Items with the same key are handled strictly in enqueue
    /// order; distinct keys proceed independently.
    pub fn enqueue(self: &Arc<Self>, key: &str, item: T) {
        let mut queues = match self.queues.lock() {
            Ok(q) => q,
            Err(_) => return,
        };
        if let Some(tx) = queues.get(key) {
            match tx.send(item) {
                Ok(()) => return,
                // The worker retired between our map read and the send —
                // fall through and start a fresh one with the item.
                Err(mpsc::error::SendError(returned)) => {
                    return self.spawn_worker(&mut queues, key, returned);
                }
            }
        }
        self.spawn_worker(&mut queues, key, item);
    }

    fn spawn_worker(
        self: &Arc<Self>,
        queues: &mut HashMap<String, mpsc::UnboundedSender<T>>,
        key: &str,
        first: T,
    ) {
        let (tx, mut rx) = mpsc::unbounded_channel::<T>();
        let _ = tx.send(first);
        queues.insert(key.to_string(), tx.clone());

        let this = self.clone();
        let key = key.to_string();
        tokio::spawn(async move {
            loop {
                match tokio::time::timeout(this.idle, rx.recv()).await {
                    Ok(Some(item)) => (this.handler)(item).await,
                    Ok(None) => break, // sender dropped (queue replaced)
                    Err(_) => {
                        // Idle: retire. Remove OUR sender from the map first
                        // (so new enqueues start a fresh worker), then bounce
                        // anything that raced into our channel back through
                        // enqueue — FIFO order preserved, nothing lost.
                        if let Ok(mut q) = this.queues.lock() {
                            if q.get(&key).is_some_and(|t| t.same_channel(&tx)) {
                                q.remove(&key);
                            }
                        }
                        while let Ok(item) = rx.try_recv() {
                            this.enqueue(&key, item);
                        }
                        break;
                    }
                }
            }
        });
    }

    /// Live (non-retired) worker count — tests/diagnostics.
    pub fn active_keys(&self) -> usize {
        self.queues.lock().map(|q| q.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Log = Arc<Mutex<Vec<(String, u32)>>>;

    /// Handler that records completions; `call_a`'s FIRST item sleeps
    /// `slow_first_ms` (the audit's artificial-latency case) so followers
    /// on the same key must queue while other keys run free.
    fn recording_handler(log: Log, slow_first_ms: u64) -> Handler<(String, u32)> {
        Arc::new(move |(key, seq): (String, u32)| {
            let log = log.clone();
            Box::pin(async move {
                if key == "call_a" && seq == 0 && slow_first_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(slow_first_ms)).await;
                }
                log.lock().unwrap().push((key, seq));
            })
        })
    }

    /// The FL-002 core guarantee: per-key order holds even when the first
    /// item is slow, and other keys are NOT blocked behind it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn per_key_order_holds_under_latency_and_keys_run_concurrently() {
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let q = SerialQueues::new(
            Duration::from_secs(30),
            recording_handler(log.clone(), 120),
        );

        // call_a's slow first event, then its followers; call_b right after.
        for seq in 0..4 {
            q.enqueue("call_a", ("call_a".into(), seq));
        }
        for seq in 0..3 {
            q.enqueue("call_b", ("call_b".into(), seq));
        }
        tokio::time::sleep(Duration::from_millis(600)).await;

        let entries = log.lock().unwrap().clone();
        let a: Vec<u32> = entries.iter().filter(|(k, _)| k == "call_a").map(|(_, s)| *s).collect();
        let b: Vec<u32> = entries.iter().filter(|(k, _)| k == "call_b").map(|(_, s)| *s).collect();
        assert_eq!(a, vec![0, 1, 2, 3], "call_a preserved arrival order");
        assert_eq!(b, vec![0, 1, 2, 3][..3], "call_b preserved arrival order");
        // Concurrency: call_b's items (fast after its slow first) finished
        // before call_a's queue drained — the slow call never blocked it.
        let first_a_follower = entries.iter().position(|(k, s)| k == "call_a" && *s == 1).unwrap();
        let last_b = entries.iter().rposition(|(k, _)| k == "call_b").unwrap();
        assert!(
            last_b < first_a_follower,
            "call_b should complete while call_a is still waiting on its slow first event: {entries:?}"
        );
    }

    /// Idle workers retire and revive without losing or reordering items.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workers_retire_when_idle_and_revive_losslessly() {
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let q = SerialQueues::new(Duration::from_millis(50), recording_handler(log.clone(), 0));

        q.enqueue("k", ("k".into(), 0));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(q.active_keys(), 0, "idle worker retired");

        // Revive with a burst — order intact.
        for seq in 1..5 {
            q.enqueue("k", ("k".into(), seq));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let seqs: Vec<u32> = log.lock().unwrap().iter().map(|(_, s)| *s).collect();
        assert_eq!(seqs, vec![0, 1, 2, 3, 4]);
    }
}
