"""Closed vocabularies shared by tensorization, training, and inference."""

RESOURCE_TYPES = (
    "Pod",
    "Node",
    "Deployment",
    "Service",
    "HPA",
    "PDB",
    "Zone",
)

RELATION_TYPES = (
    "RUNS_ON",
    "OWNS",
    "ROUTES_TO",
    "LOCATED_IN",
    "SELECTS",
    "PROTECTS",
    "SCALES",
)

RELATION_ENDPOINTS = {
    "RUNS_ON": ("Pod", "Node"),
    "OWNS": ("Deployment", "Pod"),
    "ROUTES_TO": ("Service", "Pod"),
    "LOCATED_IN": ("Node", "Zone"),
    "SELECTS": ("Service", "Deployment"),
    "PROTECTS": ("PDB", "Deployment"),
    "SCALES": ("HPA", "Deployment"),
}

ACTION_TYPES = (
    "cloud.action.roll-out",
    "cloud.action.roll-back",
    "cloud.action.scale",
    "cloud.action.drain-node",
    "cloud.action.recover-node",
    "cloud.action.advance-time",
    "cloud.action.traffic-spike",
    "cloud.fault.node-crash",
    "cloud.fault.node-drain",
    "cloud.fault.zone-degraded",
    "cloud.fault.readiness-delay",
    "cloud.fault.image-pull-delay",
    "cloud.fault.hpa-stale-metric",
    "cloud.fault.endpoint-propagation-delay",
    "cloud.fault.controller-restart",
    "cloud.controller.deployment",
    "cloud.controller.scheduler",
    "cloud.controller.kubelet",
    "cloud.controller.endpoints",
    "cloud.controller.hpa",
    "cloud.controller.pdb",
    "cloud.controller.endpoints-propagated",
    "cloud.kubelet.image-pulled",
    "cloud.kubelet.pod-ready",
    "cloud.kubelet.pod-terminated",
    "cloud.scheduler.yield",
)

ACTION_PARAMETER_NAMES = (
    "replicas",
    "version",
    "cpuPercent",
    "requestsPerSecond",
    "metric",
    "durationMs",
    "delayMs",
    "ms",
    "atMs",
)

ACTION_PARAMETER_SCALES = {
    "replicas": 32.0,
    "version": 100.0,
    "cpuPercent": 100.0,
    "requestsPerSecond": 1000.0,
    "metric": 100.0,
    "durationMs": 5000.0,
    "delayMs": 5000.0,
    "ms": 5000.0,
    "atMs": 10000.0,
}

ACTION_TARGET_TYPES = {
    "cloud.action.roll-out": "Deployment",
    "cloud.action.roll-back": "Deployment",
    "cloud.action.scale": "Deployment",
    "cloud.action.drain-node": "Node",
    "cloud.action.recover-node": "Node",
    "cloud.action.traffic-spike": "HPA",
    "cloud.fault.node-crash": "Node",
    "cloud.fault.node-drain": "Node",
    "cloud.fault.zone-degraded": "Zone",
    "cloud.fault.readiness-delay": "Pod",
    "cloud.fault.image-pull-delay": "Pod",
    "cloud.fault.hpa-stale-metric": "HPA",
    "cloud.fault.endpoint-propagation-delay": "Service",
    "cloud.fault.controller-restart": "Deployment",
    "cloud.controller.deployment": "Deployment",
    "cloud.controller.scheduler": "Pod",
    "cloud.controller.kubelet": "Pod",
    "cloud.controller.endpoints": "Service",
    "cloud.controller.hpa": "HPA",
    "cloud.controller.pdb": "PDB",
    "cloud.controller.endpoints-propagated": "Service",
    "cloud.kubelet.image-pulled": "Pod",
    "cloud.kubelet.pod-ready": "Pod",
    "cloud.kubelet.pod-terminated": "Pod",
}

NODE_FEATURE_NAMES = {
    "Pod": (
        "ready",
        "cpu_request",
        "memory_request",
        "version_number",
        "phase_pending",
        "phase_running",
        "phase_ready",
        "phase_terminating",
        "phase_failed",
    ),
    "Node": ("ready", "draining", "cpu_capacity", "memory_capacity", "taint_count"),
    "Deployment": (
        "desired_replicas",
        "desired_version",
        "max_surge",
        "max_unavailable",
        "observed_running",
        "observed_ready",
        "observed_pending",
        "observed_terminating",
        "observed_replicas",
        "rollout_active",
    ),
    "Service": ("minimum_ready", "endpoint_count"),
    "HPA": (
        "min_replicas",
        "max_replicas",
        "target_metric",
        "current_metric",
        "sampled_at",
        "recommendation",
        "active",
    ),
    "PDB": ("min_available", "disruptions_allowed"),
    "Zone": ("degraded",),
}

NODE_FEATURE_DIMS = {name: len(features) for name, features in NODE_FEATURE_NAMES.items()}
ACTION_FEATURE_DIM = len(ACTION_TYPES) + len(RESOURCE_TYPES) + 1 + len(ACTION_PARAMETER_NAMES)

# Predeclared clock-blind field list (Phase II-B.2). These are the only encoded
# inputs that carry absolute simulation progress: `HPA.sampledAtMs` is the one
# clock a scorer can read from the state graph, and `atMs` is the schedule time
# of the candidate action (already stripped from corpus v2 rows; masked so the
# declaration is complete). Durations such as `ms`, `delayMs` and `durationMs`
# are action parameters, not clocks, and stay. `state.atMs` is never encoded.
CLOCK_NODE_FEATURES = (("HPA", "sampled_at"),)
CLOCK_ACTION_PARAMETERS = ("atMs",)

ENSEMBLE_SEEDS = (1337, 2027, 4099, 7919, 104729)
SPLIT_NAMES = ("train", "validation", "test", "ood")
