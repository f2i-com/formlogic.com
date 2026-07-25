//! RUN-302/RUN-303: typed data ports at run time — the readiness rule, Rust leg.
//!
//! Mirrors `backend/src/Services/Flows/DataPortRuntime.php` and
//! `ui/src/client-runtime/flows/dataPorts.ts`; all three assert the SAME corpus at
//! `docs/contracts/fixtures/flow-data-port-cases.json`. Keeping the cases in the contracts
//! directory rather than in any one language's tests is what makes "the three runtimes agree"
//! a fact under test instead of a hope.
//!
//! The compiler already refuses data wiring that cannot work (FLOW-206). This decides, at run
//! time, whether a node may run and with what inputs. The cases that get implemented differently
//! by accident are the unhappy ones:
//!
//! - A producer on an untaken branch never produces → its consumer is **skipped**. Waiting would
//!   hang until the deadline; running would see a missing input.
//! - A **failed** producer is not the same as a skipped one — a fault to surface, not a branch
//!   not taken — so it **blocks** instead.
//! - A producer that succeeded without writing the port can never write it now: the deadlock
//!   case, refused immediately with a typed reason.
//! - Terminal verdicts beat waiting, so two runtimes cannot disagree based on arrival order.
//! - `null`, `false` and `0` are values. Falsiness is not absence.
//!
//! Artifacts pass by reference: a resolved input may carry an ArtifactRef, never bytes.

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ready,
    Waiting,
    Skipped,
    Blocked,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Ready => "ready",
            Verdict::Waiting => "waiting",
            Verdict::Skipped => "skipped",
            Verdict::Blocked => "blocked",
        }
    }
}

/// What a node has done so far. `Absent` means it has not run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutcomeState {
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    Absent,
}

impl OutcomeState {
    fn from_str(s: &str) -> Self {
        match s {
            "succeeded" => OutcomeState::Succeeded,
            "failed" => OutcomeState::Failed,
            "skipped" => OutcomeState::Skipped,
            "cancelled" => OutcomeState::Cancelled,
            _ => OutcomeState::Absent,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct NodeOutcome {
    pub state: Option<String>,
    pub outputs: Map<String, Value>,
}

impl NodeOutcome {
    pub fn succeeded(outputs: Map<String, Value>) -> Self {
        Self { state: Some("succeeded".into()), outputs }
    }
    pub fn terminal(state: &str) -> Self {
        Self { state: Some(state.into()), outputs: Map::new() }
    }
    fn state(&self) -> OutcomeState {
        OutcomeState::from_str(self.state.as_deref().unwrap_or("absent"))
    }
}

/// Compiled data plan: consumer node id → input port → the (node, port) that produces it.
pub type DataPlan = HashMap<String, HashMap<String, (String, String)>>;

#[derive(Debug, Clone)]
pub struct Readiness {
    pub verdict: Verdict,
    pub inputs: Map<String, Value>,
    /// Input ports whose resolved value is an ArtifactRef (a handle, never bytes).
    pub artifact_inputs: Vec<String>,
    pub waiting_on: Vec<String>,
    pub unsatisfied: Vec<String>,
    pub reason: Option<String>,
}

impl Readiness {
    fn ready(inputs: Map<String, Value>, artifact_inputs: Vec<String>) -> Self {
        Self {
            verdict: Verdict::Ready,
            inputs,
            artifact_inputs,
            waiting_on: Vec::new(),
            unsatisfied: Vec::new(),
            reason: None,
        }
    }
    fn stop(verdict: Verdict, unsatisfied: Vec<String>, reason: Option<String>) -> Self {
        Self {
            verdict,
            inputs: Map::new(),
            artifact_inputs: Vec::new(),
            waiting_on: Vec::new(),
            unsatisfied,
            reason,
        }
    }
    fn waiting(waiting_on: Vec<String>) -> Self {
        Self {
            verdict: Verdict::Waiting,
            inputs: Map::new(),
            artifact_inputs: Vec::new(),
            waiting_on,
            unsatisfied: Vec::new(),
            reason: None,
        }
    }
}

/// Is this value an ArtifactRef? Mirrors `ArtifactService::isRef`.
pub fn is_artifact_ref(value: &Value) -> bool {
    let Some(id) = value.get("$artifact").and_then(Value::as_str) else {
        return false;
    };
    id.len() == 28
        && id.starts_with("art_")
        && id[4..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Decide whether `node_id` may run, and with what inputs.
pub fn readiness(plan: &DataPlan, outcomes: &HashMap<String, NodeOutcome>, node_id: &str) -> Readiness {
    let Some(ports) = plan.get(node_id).filter(|p| !p.is_empty()) else {
        // No data inputs — a control-only node, or a legacy graph with no data edges at all.
        return Readiness::ready(Map::new(), Vec::new());
    };

    let mut inputs = Map::new();
    let mut artifact_inputs = Vec::new();
    let mut waiting_on = Vec::new();
    // Terminal outcomes are gathered separately so they win over waiting regardless of the
    // order ports happen to be iterated in. HashMap iteration is arbitrary, so the port lists
    // are sorted before they are reported — a verdict must never depend on hash order.
    let mut blocked_ports: Vec<String> = Vec::new();
    let mut skipped_ports: Vec<String> = Vec::new();
    let mut blocked_reason: Option<String> = None;

    let mut port_names: Vec<&String> = ports.keys().collect();
    port_names.sort();

    for port in port_names {
        let (producer_id, producer_port) = &ports[port];
        let outcome = outcomes.get(producer_id);
        let state = outcome.map(NodeOutcome::state).unwrap_or(OutcomeState::Absent);

        match state {
            OutcomeState::Succeeded => {
                // `contains_key`, NOT a truthiness check: a produced null/false/0 is a value.
                match outcome.and_then(|o| o.outputs.get(producer_port)) {
                    Some(value) => {
                        if is_artifact_ref(value) {
                            artifact_inputs.push(port.clone());
                        }
                        inputs.insert(port.clone(), value.clone());
                    }
                    // Finished without writing the port — waiting can never end.
                    None => skipped_ports.push(port.clone()),
                }
            }
            OutcomeState::Failed => {
                blocked_ports.push(port.clone());
                blocked_reason.get_or_insert_with(|| "data_producer_failed".to_string());
            }
            OutcomeState::Cancelled => {
                blocked_ports.push(port.clone());
                blocked_reason.get_or_insert_with(|| "data_producer_cancelled".to_string());
            }
            OutcomeState::Skipped => skipped_ports.push(port.clone()),
            OutcomeState::Absent => {
                if !waiting_on.contains(producer_id) {
                    waiting_on.push(producer_id.clone());
                }
            }
        }
    }

    if !blocked_ports.is_empty() {
        return Readiness::stop(Verdict::Blocked, blocked_ports, blocked_reason);
    }
    if !skipped_ports.is_empty() {
        return Readiness::stop(Verdict::Skipped, skipped_ports, Some("data_input_unsatisfied".into()));
    }
    if !waiting_on.is_empty() {
        return Readiness::waiting(waiting_on);
    }
    Readiness::ready(inputs, artifact_inputs)
}

/// Build the data plan from a compiled graph's data edges, or read the compiler's own.
///
/// The compiled IR carries `dataPlan` so all three runtimes read the SAME wiring rather than
/// deriving it three times; deriving is the fallback for a graph the compiler never saw.
pub fn plan_from(graph: &Value) -> DataPlan {
    if let Some(plan) = graph.get("dataPlan").and_then(Value::as_object) {
        let mut out: DataPlan = HashMap::new();
        for (consumer, ports) in plan {
            let Some(ports) = ports.as_object() else { continue };
            let mut map = HashMap::new();
            for (port, source) in ports {
                let (Some(node), Some(sp)) = (
                    source.get("node").and_then(Value::as_str),
                    source.get("port").and_then(Value::as_str),
                ) else {
                    continue;
                };
                map.insert(port.clone(), (node.to_string(), sp.to_string()));
            }
            if !map.is_empty() {
                out.insert(consumer.clone(), map);
            }
        }
        return out;
    }

    let mut plan: DataPlan = HashMap::new();
    let mut claimed: HashSet<(String, String)> = HashSet::new();
    for edge in graph.get("edges").and_then(Value::as_array).unwrap_or(&Vec::new()) {
        if edge.get("kind").and_then(Value::as_str) != Some("data") {
            continue;
        }
        let (Some(target), Some(target_port), Some(source), Some(source_port)) = (
            edge.get("target").and_then(Value::as_str),
            edge.get("targetHandle").and_then(Value::as_str),
            edge.get("source").and_then(Value::as_str),
            edge.get("sourceHandle").and_then(Value::as_str),
        ) else {
            continue; // an incomplete data edge carries no wiring
        };
        // Ambiguous fan-in is refused at compile; first-writer-wins here so a corrupt plan
        // degrades deterministically rather than by iteration order.
        if !claimed.insert((target.to_string(), target_port.to_string())) {
            continue;
        }
        plan.entry(target.to_string())
            .or_default()
            .insert(target_port.to_string(), (source.to_string(), source_port.to_string()));
    }
    plan
}

/// A node's output PORT map, by the same convention the browser and cloud use: an object result
/// exposes its own keys as ports, and every result is additionally available on the conventional
/// `output` port. Single-value nodes stay wireable without authors wrapping scalars, and a node
/// already returning `{ text, url }` feeds typed ports as-is.
pub fn output_ports_of(output: &Value) -> Map<String, Value> {
    let mut map = match output.as_object() {
        Some(obj) => obj.clone(),
        None => Map::new(),
    };
    map.insert("output".into(), output.clone());
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The SHARED corpus every runtime asserts. Loaded from docs/contracts so a change to the
    /// semantics has to be made once, in the contract, rather than three times in three tests.
    fn corpus() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/contracts/fixtures/flow-data-port-cases.json"
        );
        let raw = std::fs::read_to_string(path).expect("shared data-port corpus is readable");
        serde_json::from_str(&raw).expect("shared data-port corpus is valid JSON")
    }

    fn plan_of(value: &Value) -> DataPlan {
        let mut plan: DataPlan = HashMap::new();
        for (consumer, ports) in value.as_object().expect("plan is an object") {
            let mut map = HashMap::new();
            for (port, source) in ports.as_object().expect("ports is an object") {
                map.insert(
                    port.clone(),
                    (
                        source["node"].as_str().unwrap_or_default().to_string(),
                        source["port"].as_str().unwrap_or_default().to_string(),
                    ),
                );
            }
            plan.insert(consumer.clone(), map);
        }
        plan
    }

    fn outcomes_of(value: &Value) -> HashMap<String, NodeOutcome> {
        let mut out = HashMap::new();
        for (node, outcome) in value.as_object().expect("outcomes is an object") {
            out.insert(
                node.clone(),
                NodeOutcome {
                    state: outcome.get("state").and_then(Value::as_str).map(str::to_string),
                    outputs: outcome
                        .get("outputs")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default(),
                },
            );
        }
        out
    }

    #[test]
    fn the_shared_conformance_corpus_holds_in_rust_too() {
        let corpus = corpus();
        let cases = corpus["cases"].as_array().expect("cases array");
        assert!(cases.len() > 10, "a corpus that fails to load would make this test vacuous");

        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let result = readiness(
                &plan_of(&case["plan"]),
                &outcomes_of(&case["outcomes"]),
                case["node"].as_str().expect("node id"),
            );
            let expected = &case["expect"];

            assert_eq!(
                result.verdict.as_str(),
                expected["verdict"].as_str().expect("verdict"),
                "case '{name}': {}",
                case["why"].as_str().unwrap_or("")
            );
            if let Some(inputs) = expected.get("inputs").and_then(Value::as_object) {
                assert_eq!(&result.inputs, inputs, "case '{name}': resolved inputs");
            }
            if let Some(artifacts) = expected.get("artifactInputs").and_then(Value::as_array) {
                let expected: Vec<String> =
                    artifacts.iter().filter_map(Value::as_str).map(str::to_string).collect();
                assert_eq!(result.artifact_inputs, expected, "case '{name}': artifact inputs");
            }
            if let Some(waiting) = expected.get("waitingOn").and_then(Value::as_array) {
                let expected: Vec<String> =
                    waiting.iter().filter_map(Value::as_str).map(str::to_string).collect();
                assert_eq!(result.waiting_on, expected, "case '{name}': waiting on");
            }
            if let Some(unsatisfied) = expected.get("unsatisfied").and_then(Value::as_array) {
                let expected: Vec<String> =
                    unsatisfied.iter().filter_map(Value::as_str).map(str::to_string).collect();
                assert_eq!(result.unsatisfied, expected, "case '{name}': unsatisfied ports");
            }
            if let Some(reason) = expected.get("reason").and_then(Value::as_str) {
                assert_eq!(result.reason.as_deref(), Some(reason), "case '{name}': reason");
            }
        }
    }

    #[test]
    fn plan_from_prefers_the_compilers_plan_over_re_deriving_edges() {
        // The compiler is authoritative. If it says port `text` comes from `a`, a stale or
        // contradictory edge list must not silently rewire the flow.
        let graph = serde_json::json!({
            "dataPlan": { "b": { "text": { "node": "a", "port": "out" } } },
            "edges": [
                { "kind": "data", "source": "impostor", "target": "b", "sourceHandle": "out", "targetHandle": "text" }
            ]
        });
        let plan = plan_from(&graph);
        assert_eq!(plan["b"]["text"], ("a".to_string(), "out".to_string()));
    }

    #[test]
    fn plan_from_reads_only_complete_data_edges() {
        let graph = serde_json::json!({
            "edges": [
                { "kind": "control", "source": "a", "target": "b", "sourceHandle": "out", "targetHandle": "in" },
                { "kind": "data", "source": "a", "target": "b", "sourceHandle": "out", "targetHandle": "text" },
                { "kind": "data", "source": "a", "target": "c", "sourceHandle": "out" }
            ]
        });
        let plan = plan_from(&graph);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan["b"]["text"], ("a".to_string(), "out".to_string()));
    }

    #[test]
    fn a_corrupt_double_wired_port_resolves_deterministically() {
        let graph = serde_json::json!({
            "edges": [
                { "kind": "data", "source": "first", "target": "z", "sourceHandle": "out", "targetHandle": "in" },
                { "kind": "data", "source": "second", "target": "z", "sourceHandle": "out", "targetHandle": "in" }
            ]
        });
        assert_eq!(plan_from(&graph)["z"]["in"], ("first".to_string(), "out".to_string()));
    }

    #[test]
    fn a_tampered_plan_entry_can_never_be_satisfied() {
        // RUN-303: unsupported/tampered IR must be REJECTED, not guessed at. A plan entry whose
        // producer fields were stripped resolves to nothing, so the consumer is skipped rather
        // than run with whatever happened to be lying around.
        let graph = serde_json::json!({ "dataPlan": { "b": { "text": { "node": 42, "port": null } } } });
        let plan = plan_from(&graph);
        assert!(plan.get("b").is_none(), "a malformed plan entry contributes no wiring");
    }

    #[test]
    fn legacy_graphs_produce_an_empty_plan() {
        let graph = serde_json::json!({ "edges": [{ "source": "a", "target": "b" }] });
        assert!(plan_from(&graph).is_empty());
        assert!(plan_from(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn output_ports_expose_object_keys_and_the_conventional_output_port() {
        let obj = serde_json::json!({ "text": "hi", "url": "https://example.test" });
        let ports = output_ports_of(&obj);
        assert_eq!(ports["text"], serde_json::json!("hi"));
        assert_eq!(ports["output"], obj);

        let scalar = serde_json::json!(7);
        let ports = output_ports_of(&scalar);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports["output"], scalar);
    }

    #[test]
    fn artifact_refs_are_recognised_by_shape_only() {
        assert!(is_artifact_ref(&serde_json::json!({ "$artifact": "art_abcdefghijklmnopqrstuvwx" })));
        for not_ref in [
            serde_json::json!(null),
            serde_json::json!("art_abc"),
            serde_json::json!(42),
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!({ "$artifact": "nope" }),
            serde_json::json!({ "$artifact": "ART_ABCDEFGHIJKLMNOPQRSTUVWX" }),
        ] {
            assert!(!is_artifact_ref(&not_ref), "{not_ref:?} is not an artifact ref");
        }
    }
}
