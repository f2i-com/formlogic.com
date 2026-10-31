//! Work that takes longer than OAIY waits for an answer: a confirmation the person hasn't answered
//! yet, a backup, a restore. A command starts a job and answers with its id at once; the page asks
//! after it with `jobs.get`.
//!
//! OAIY sends a journalled command again if an answer is lost, under the same request id. That
//! finds the job the first one started, so nothing runs twice and no second window opens.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

/// Finished jobs kept for a page to read. The oldest goes first.
const KEEP: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub command: String,
    /// `running`, `done` or `failed`.
    pub state: String,
    pub message: Option<String>,
    pub result: Option<Value>,
}

#[derive(Default)]
struct Table {
    jobs: HashMap<String, Job>,
    by_request: HashMap<String, String>,
    order: VecDeque<String>,
}

#[derive(Default)]
pub struct Jobs(Mutex<Table>);

pub enum Started {
    /// A new job: the caller runs it.
    New(String),
    /// This request started one already.
    Again(String),
}

fn random_id() -> Result<String, String> {
    let mut random = [0u8; 12];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    Ok(format!("job-{}", random.iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

impl Jobs {
    pub fn start(&self, request_id: Option<&str>, command: &str) -> Result<Started, String> {
        let mut table = self.0.lock().map_err(|_| "The plugin stopped unexpectedly.")?;
        if let Some(found) = request_id.and_then(|request| table.by_request.get(request)) {
            return Ok(Started::Again(found.clone()));
        }
        let id = random_id()?;
        table.jobs.insert(id.clone(), Job { id: id.clone(), command: command.to_string(), state: "running".to_string(), message: None, result: None });
        if let Some(request) = request_id {
            table.by_request.insert(request.to_string(), id.clone());
        }
        table.order.push_back(id.clone());
        Self::trim(&mut table);
        Ok(Started::New(id))
    }

    fn trim(table: &mut Table) {
        while table.order.len() > KEEP {
            let Some(at) = table.order.iter().position(|id| table.jobs.get(id).is_none_or(|job| job.state != "running")) else { return };
            if let Some(gone) = table.order.remove(at) {
                table.jobs.remove(&gone);
                table.by_request.retain(|_, id| *id != gone);
            }
        }
    }

    /// How far it has got, for the page.
    pub fn step(&self, id: &str, message: &str) {
        if let Ok(mut table) = self.0.lock() {
            if let Some(job) = table.jobs.get_mut(id) {
                job.message = Some(message.to_string());
            }
        }
    }

    pub fn finish(&self, id: &str, outcome: Result<Value, String>) {
        if let Ok(mut table) = self.0.lock() {
            if let Some(job) = table.jobs.get_mut(id) {
                match outcome {
                    Ok(result) => {
                        job.state = "done".to_string();
                        job.message = None;
                        job.result = Some(result);
                    }
                    Err(message) => {
                        job.state = "failed".to_string();
                        job.message = Some(message);
                    }
                }
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        self.0.lock().ok()?.jobs.get(id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id_of(started: Started) -> (String, bool) {
        match started {
            Started::New(id) => (id, true),
            Started::Again(id) => (id, false),
        }
    }

    #[test]
    fn the_same_request_finds_the_same_job() {
        let jobs = Jobs::default();
        let (first, new) = id_of(jobs.start(Some("r1"), "backup.run").unwrap());
        assert!(new);
        let (second, new) = id_of(jobs.start(Some("r1"), "backup.run").unwrap());
        assert!(!new, "a retry must not run it again");
        assert_eq!(first, second);
    }

    #[test]
    fn another_request_is_another_job() {
        let jobs = Jobs::default();
        let (first, _) = id_of(jobs.start(Some("r1"), "backup.run").unwrap());
        let (second, _) = id_of(jobs.start(Some("r2"), "backup.run").unwrap());
        assert_ne!(first, second);
    }

    #[test]
    fn a_job_says_how_it_ended() {
        let jobs = Jobs::default();
        let (id, _) = id_of(jobs.start(None, "backup.run").unwrap());
        assert_eq!(jobs.get(&id).unwrap().state, "running");
        jobs.step(&id, "1 of 2");
        assert_eq!(jobs.get(&id).unwrap().message.as_deref(), Some("1 of 2"));
        jobs.finish(&id, Ok(json!({"saved": 2})));
        let done = jobs.get(&id).unwrap();
        assert_eq!((done.state.as_str(), done.message), ("done", None));
        assert_eq!(done.result, Some(json!({"saved": 2})));

        let (id, _) = id_of(jobs.start(None, "backup.run").unwrap());
        jobs.finish(&id, Err("no".to_string()));
        assert_eq!(jobs.get(&id).unwrap().state, "failed");
    }

    #[test]
    fn only_finished_jobs_are_let_go() {
        let jobs = Jobs::default();
        let (waiting, _) = id_of(jobs.start(Some("first"), "key.setup").unwrap());
        for n in 0..(KEEP * 2) {
            let (id, _) = id_of(jobs.start(Some(&format!("r{n}")), "backup.run").unwrap());
            jobs.finish(&id, Ok(Value::Null));
        }
        assert!(jobs.get(&waiting).is_some(), "someone is still answering this one");
        assert_eq!(jobs.0.lock().unwrap().jobs.len(), KEEP);
        assert_eq!(jobs.0.lock().unwrap().by_request.len(), KEEP, "the request ids go with them");
    }
}
