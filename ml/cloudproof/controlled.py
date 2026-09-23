"""Controlled topology-equivalence experiment for zone concentration."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .model import ensemble_predict
from .tensorize import CloudProofTensorizer, collate_graphs


def _zone_nodes(graph: dict[str, Any]) -> list[list[str]]:
    zones = sorted(node["id"] for node in graph["nodes"] if node.get("type") == "Zone")
    nodes_by_zone = []
    for zone in zones:
        nodes = sorted(
            edge["from"]
            for edge in graph["edges"]
            if edge.get("type") == "LOCATED_IN" and edge.get("to") == zone
        )
        if not nodes:
            raise ValueError(f"zone {zone} has no node")
        nodes_by_zone.append(nodes)
    if len(nodes_by_zone) != 3:
        raise ValueError("controlled experiment requires exactly three zones")
    return nodes_by_zone


def zone_concentration_variants(graph: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict]:
    pods = sorted(node["id"] for node in graph["nodes"] if node.get("type") == "Pod")
    if len(pods) != 6:
        raise ValueError("controlled experiment requires exactly six pods")
    nodes_by_zone = _zone_nodes(graph)

    def assigned(counts: tuple[int, int, int]) -> dict[str, Any]:
        candidate = deepcopy(graph)
        candidate["edges"] = [edge for edge in candidate["edges"] if edge.get("type") != "RUNS_ON"]
        cursor = 0
        for zone_index, count in enumerate(counts):
            nodes = nodes_by_zone[zone_index]
            for local_index in range(count):
                candidate["edges"].append(
                    {
                        "from": pods[cursor],
                        "to": nodes[local_index % len(nodes)],
                        "type": "RUNS_ON",
                    }
                )
                cursor += 1
        candidate["edges"].sort(key=lambda edge: (edge["from"], edge["to"], edge["type"]))
        return candidate

    action = {"type": "cloud.fault.zone-degraded", "zoneId": nodes_by_zone and sorted(
        node["id"] for node in graph["nodes"] if node.get("type") == "Zone"
    )[0]}
    return assigned((2, 2, 2)), assigned((4, 1, 1)), action


def run_zone_concentration_experiment(models, record: dict, device="cpu") -> dict:
    balanced, concentrated, action = zone_concentration_variants(record["state"])
    tensorizer = CloudProofTensorizer()
    batch = collate_graphs(
        [tensorizer.tensorize(balanced, action), tensorizer.tensorize(concentrated, action)]
    ).to(device)
    risk, uncertainty = ensemble_predict(models, batch)
    values = risk.cpu().tolist()
    uncertainty_values = uncertainty.cpu().tolist()
    return {
        "kind": "cloudproof.zone-concentration-experiment",
        "schemaVersion": 1,
        "action": "ZONE_FAILURE(A)",
        "balanced": {
            "placement": [2, 2, 2],
            "risk": values[0],
            "uncertainty": uncertainty_values[0],
        },
        "concentrated": {
            "placement": [4, 1, 1],
            "risk": values[1],
            "uncertainty": uncertainty_values[1],
        },
        "riskDelta": values[1] - values[0],
        "ranksConcentratedHigher": values[1] > values[0],
    }
