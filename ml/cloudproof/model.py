"""Small relation-aware graph models for CloudProof risk ranking."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterable

import torch
from torch import nn

from .constants import (
    ACTION_FEATURE_DIM,
    NODE_FEATURE_DIMS,
    RELATION_ENDPOINTS,
    RELATION_TYPES,
    RESOURCE_TYPES,
)
from .tensorize import GraphBatch


@dataclass(frozen=True)
class ModelConfig:
    hidden_dim: int = 48
    layers: int = 2
    dropout: float = 0.1
    use_edge_types: bool = True
    use_action_embedding: bool = True
    use_zone_relations: bool = True
    flat_mlp: bool = False

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict) -> "ModelConfig":
        allowed = cls.__dataclass_fields__.keys()
        return cls(**{key: value[key] for key in allowed if key in value})


def _segment_mean(values: torch.Tensor, groups: torch.Tensor, group_count: int) -> torch.Tensor:
    output = values.new_zeros((group_count, values.shape[-1]))
    counts = values.new_zeros((group_count, 1))
    if values.shape[0] == 0:
        return output
    output.index_add_(0, groups, values)
    counts.index_add_(0, groups, values.new_ones((values.shape[0], 1)))
    return output / counts.clamp_min(1.0)


class RelationLayer(nn.Module):
    def __init__(self, hidden_dim: int, dropout: float, use_edge_types: bool) -> None:
        super().__init__()
        self.self_transforms = nn.ModuleDict({
            node_type: nn.Linear(hidden_dim, hidden_dim) for node_type in RESOURCE_TYPES
        })
        relation_names: Iterable[str] = RELATION_TYPES if use_edge_types else ("shared",)
        self.forward_transforms = nn.ModuleDict({
            name: nn.Linear(hidden_dim, hidden_dim, bias=False) for name in relation_names
        })
        self.reverse_transforms = nn.ModuleDict({
            name: nn.Linear(hidden_dim, hidden_dim, bias=False) for name in relation_names
        })
        self.norms = nn.ModuleDict({node_type: nn.LayerNorm(hidden_dim) for node_type in RESOURCE_TYPES})
        self.dropout = nn.Dropout(dropout)
        self.use_edge_types = use_edge_types

    def forward(
        self,
        states: dict[str, torch.Tensor],
        edges: dict[str, torch.Tensor],
        use_zone_relations: bool,
    ) -> dict[str, torch.Tensor]:
        aggregates = {node_type: torch.zeros_like(values) for node_type, values in states.items()}
        counts = {
            node_type: values.new_zeros((values.shape[0], 1)) for node_type, values in states.items()
        }
        for relation in RELATION_TYPES:
            if relation == "LOCATED_IN" and not use_zone_relations:
                continue
            edge_index = edges[relation]
            if edge_index.shape[1] == 0:
                continue
            source_type, target_type = RELATION_ENDPOINTS[relation]
            source_indices, target_indices = edge_index[0], edge_index[1]
            transform_name = relation if self.use_edge_types else "shared"
            forward_messages = self.forward_transforms[transform_name](states[source_type][source_indices])
            reverse_messages = self.reverse_transforms[transform_name](states[target_type][target_indices])
            aggregates[target_type].index_add_(0, target_indices, forward_messages)
            aggregates[source_type].index_add_(0, source_indices, reverse_messages)
            counts[target_type].index_add_(
                0, target_indices, counts[target_type].new_ones((target_indices.shape[0], 1))
            )
            counts[source_type].index_add_(
                0, source_indices, counts[source_type].new_ones((source_indices.shape[0], 1))
            )
        output = {}
        for node_type in RESOURCE_TYPES:
            messages = aggregates[node_type] / counts[node_type].clamp_min(1.0)
            updated = self.self_transforms[node_type](states[node_type]) + messages
            output[node_type] = self.dropout(torch.relu(self.norms[node_type](updated)))
        return output


class HeterogeneousRiskGNN(nn.Module):
    def __init__(self, config: ModelConfig | None = None) -> None:
        super().__init__()
        self.config = config or ModelConfig()
        hidden = self.config.hidden_dim
        self.input_encoders = nn.ModuleDict({
            node_type: nn.Sequential(nn.Linear(NODE_FEATURE_DIMS[node_type], hidden), nn.ReLU())
            for node_type in RESOURCE_TYPES
        })
        self.message_layers = nn.ModuleList([
            RelationLayer(hidden, self.config.dropout, self.config.use_edge_types)
            for _ in range(self.config.layers)
        ])
        self.action_encoder = nn.Sequential(
            nn.Linear(ACTION_FEATURE_DIM, hidden),
            nn.ReLU(),
            nn.Dropout(self.config.dropout),
        )
        combined_dim = len(RESOURCE_TYPES) * hidden + 2 * hidden
        self.risk_head = nn.Sequential(
            nn.Linear(combined_dim, hidden),
            nn.ReLU(),
            nn.Dropout(self.config.dropout),
            nn.Linear(hidden, 1),
        )

    def forward(self, batch: GraphBatch) -> torch.Tensor:
        states = {
            node_type: self.input_encoders[node_type](batch.node_features[node_type])
            for node_type in RESOURCE_TYPES
        }
        for layer in self.message_layers:
            states = layer(states, batch.edges, self.config.use_zone_relations)
        graph_parts = [
            _segment_mean(states[node_type], batch.node_batches[node_type], batch.graph_count)
            for node_type in RESOURCE_TYPES
        ]
        graph_embedding = torch.cat(graph_parts, dim=1)

        target_embedding = graph_embedding.new_zeros((batch.graph_count, self.config.hidden_dim))
        for node_type in RESOURCE_TYPES:
            target_rows = batch.targets[node_type]
            if target_rows.shape[1] == 0:
                continue
            target_embedding[target_rows[0]] = states[node_type][target_rows[1]]
        action_embedding = self.action_encoder(batch.action_features)
        if not self.config.use_action_embedding:
            action_embedding = torch.zeros_like(action_embedding)
            target_embedding = torch.zeros_like(target_embedding)
        combined = torch.cat([graph_embedding, action_embedding, target_embedding], dim=1)
        return self.risk_head(combined).squeeze(-1)


class FlatPooledRiskMLP(nn.Module):
    """Ablation with typed mean pooling but no graph message passing."""

    def __init__(self, config: ModelConfig | None = None) -> None:
        super().__init__()
        raw_dim = sum(NODE_FEATURE_DIMS.values()) + ACTION_FEATURE_DIM
        config = config or ModelConfig(flat_mlp=True)
        self.config = config
        hidden = config.hidden_dim
        self.network = nn.Sequential(
            nn.Linear(raw_dim, hidden),
            nn.ReLU(),
            nn.Dropout(config.dropout),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Dropout(config.dropout),
            nn.Linear(hidden, 1),
        )

    def forward(self, batch: GraphBatch) -> torch.Tensor:
        graph_parts = [
            _segment_mean(
                batch.node_features[node_type], batch.node_batches[node_type], batch.graph_count
            )
            for node_type in RESOURCE_TYPES
        ]
        action = batch.action_features
        if not self.config.use_action_embedding:
            action = torch.zeros_like(action)
        return self.network(torch.cat([*graph_parts, action], dim=1)).squeeze(-1)


def build_model(config: ModelConfig | dict | None = None) -> nn.Module:
    if config is None:
        config = ModelConfig()
    elif isinstance(config, dict):
        config = ModelConfig.from_dict(config)
    if config.flat_mlp:
        return FlatPooledRiskMLP(config)
    return HeterogeneousRiskGNN(config)


@torch.no_grad()
def ensemble_predict(models: list[nn.Module], batch: GraphBatch) -> tuple[torch.Tensor, torch.Tensor]:
    if not models:
        raise ValueError("at least one ensemble member is required")
    predictions = torch.stack([torch.sigmoid(model(batch)) for model in models], dim=0)
    return predictions.mean(dim=0), predictions.std(dim=0, unbiased=False)
