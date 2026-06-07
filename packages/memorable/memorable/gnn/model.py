"""WorkflowGNN — scores tools for a task type using graph structure."""

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.nn import GCNConv


class WorkflowGNN(nn.Module):
    def __init__(
        self,
        n_tools: int,
        n_tasks: int,
        tool_feat_dim: int = 32,
        task_emb_dim: int = 16,
        hidden_dim: int = 48,
    ):
        super().__init__()
        self.tool_embed = nn.Embedding(n_tools, tool_feat_dim)
        self.task_embed = nn.Embedding(n_tasks, task_emb_dim)
        input_dim = tool_feat_dim + task_emb_dim
        self.conv1 = GCNConv(input_dim, hidden_dim)
        self.conv2 = GCNConv(hidden_dim, hidden_dim)
        self.scorer = nn.Linear(hidden_dim, 1)

    def forward(self, tool_ids, edge_index, edge_weight, task_id):
        tool_feats = self.tool_embed(tool_ids)
        task_feats = self.task_embed(task_id).unsqueeze(0).expand(tool_feats.size(0), -1)
        x = torch.cat([tool_feats, task_feats], dim=-1)
        x = F.relu(self.conv1(x, edge_index, edge_weight))
        x = F.dropout(x, p=0.2, training=self.training)
        x = F.relu(self.conv2(x, edge_index, edge_weight))
        return torch.sigmoid(self.scorer(x).squeeze(-1))
