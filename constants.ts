
import { NodeType } from './types';

export const NODE_COLORS: Record<NodeType, { bg: string; border: string; text: string; label: string }> = {
  [NodeType.ROOT]: { bg: 'bg-purple-950', border: 'border-purple-500', text: 'text-purple-200', label: '世界观/核心设定' },
  [NodeType.OUTLINE]: { bg: 'bg-blue-950', border: 'border-blue-500', text: 'text-blue-200', label: '分卷/大副本规划' },
  [NodeType.PLOT]: { bg: 'bg-emerald-950', border: 'border-emerald-500', text: 'text-emerald-200', label: '区域剧情/事件流' },
  [NodeType.CHAPTER]: { bg: 'bg-slate-900', border: 'border-amber-500', text: 'text-amber-100', label: '章节正文' },
  [NodeType.CHARACTER]: { bg: 'bg-pink-950', border: 'border-pink-500', text: 'text-pink-200', label: '角色设定' },
  [NodeType.ITEM]: { bg: 'bg-indigo-950', border: 'border-indigo-500', text: 'text-indigo-200', label: '物品/功法' },
  [NodeType.LOCATION]: { bg: 'bg-teal-950', border: 'border-teal-500', text: 'text-teal-200', label: '地点/地图' },
  [NodeType.FACTION]: { bg: 'bg-orange-950', border: 'border-orange-500', text: 'text-orange-200', label: '势力/组织' },
};

export const HIERARCHY_RULES: Record<string, NodeType[]> = {
    [NodeType.ROOT]: [NodeType.OUTLINE],
    [NodeType.OUTLINE]: [NodeType.PLOT],
    [NodeType.PLOT]: [NodeType.CHAPTER], // Plot breaks down into Chapters
    [NodeType.CHAPTER]: [], // Leaf node, no children
    [NodeType.CHARACTER]: [],
    [NodeType.ITEM]: [],
    [NodeType.LOCATION]: [],
    [NodeType.FACTION]: []
};

export const NOVEL_STYLES = [
  '东方玄幻/修仙',
  '传统武侠',
  '现代都市/异能',
  '科幻/赛博朋克',
  '克苏鲁/诡秘',
  '悬疑/刑侦',
  '历史/架空',
  '西方奇幻',
  '末世/无限流',
  '二次元/轻小说'
];

export const DEFAULT_SETTINGS = {
  apiKey: '', // Empty by default, user must provide
  baseUrl: '',
  modelName: 'gemini-2.5-flash',
  temperature: 0.85,
  thinkingBudget: 1024, // Enable reasoning by default for better plotting
  novelStyle: '东方玄幻/修仙',
  systemInstruction: `你是一位顶级网文架构师。
核心创作法则：【地图推进】+【高密度事件】。
1. **结构布局**：小说必须基于“大副本/大地图”进行推进。每一卷由2-3个大副本组成，每个大副本包含“从边缘小区域 -> 核心大区域 -> 上层区域”的层级跃迁。
2. **事件驱动**：拒绝流水账。最小叙事单位是【一个事件】。
   - 【一个事件】的定义：主角面临选择 -> 做出行动 -> 产生后果（包括对话、战斗结果、获得物品、人际关系变化）。
   - 一章正文至少包含 3 个以上的完整事件。
3. **逻辑严密**：前后的伏笔、物品获取、战力提升必须有严格的因果链条。`,
};

export const DEFAULT_NODES = [
  {
    id: 'root-1',
    type: NodeType.ROOT,
    title: '《修仙模拟器》核心设定',
    summary: '【世界背景】：灵气复苏的现代都市，古老宗门隐世不出，唯有通过一款神秘的VR游戏《元宇宙》才能获取修仙资源。\n【力量体系】：练气 -> 筑基 -> 金丹 -> 元婴 -> 化神（都市目前最高战力为金丹期）。\n【主角】：李凡，一名普通的社畜程序员，意外发现了游戏代码中的BUG，可以无限刷初始属性。\n【主线】：利用BUG在游戏中通过滚雪球优势，同步反馈到现实，最终揭开灵气复苏背后的外星文明阴谋。',
    content: '',
    x: 100,
    y: 300,
    parentId: null,
    childrenIds: [],
    collapsed: false,
    associations: []
  }
];
