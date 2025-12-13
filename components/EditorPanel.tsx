
import React, { useState } from 'react';
import { NodeData, NodeType, AppSettings, LogicValidationResult, LoreUpdateSuggestion } from '../types';
import { Sparkles, X, Trash2, BookOpen, FileText, ShieldCheck, AlertTriangle, Wand2, RefreshCw, Link as LinkIcon, UserPlus, ArrowRightCircle, ListTree, GitMerge, Layout, Globe, PenTool, Hash, ArrowLeft, BrainCircuit, Type as TypeIcon } from 'lucide-react';
import { generateChapterContent, generateNodeExpansion, validateStoryLogic, refineContent, extractLoreUpdates, generateRefinementPrompt } from '../services/geminiService';
import { NODE_COLORS, HIERARCHY_RULES } from '../constants';

interface EditorPanelProps {
  node: NodeData | null;
  nodes: NodeData[];
  settings: AppSettings;
  storyContext?: string; // NEW: Context passed from App
  onUpdate: (id: string, updates: Partial<NodeData>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onAddChildren: (parentId: string, newNodes: Partial<NodeData>[]) => void;
  onAddSibling: (prevNodeId: string, newNode: Partial<NodeData>) => void;
  onSyncLoreUpdates: (updates: LoreUpdateSuggestion[]) => void;
  setGlobalLoading: (loading: boolean) => void; 
}

const EditorPanel: React.FC<EditorPanelProps> = ({ node, nodes, settings, storyContext, onUpdate, onDelete, onClose, onAddChildren, onAddSibling, onSyncLoreUpdates, setGlobalLoading }) => {
  const [activeTab, setActiveTab] = useState<'meta' | 'editor'>('meta');
  const [logicResult, setLogicResult] = useState<LogicValidationResult | null>(null);
  
  // Refine Inputs
  const [polishInput, setPolishInput] = useState('');
  const [summaryPolishInput, setSummaryPolishInput] = useState('');

  // Prompt Generator UI
  const [showPromptGen, setShowPromptGen] = useState(false);
  const [genPromptIntent, setGenPromptIntent] = useState('');

  const [showAssociator, setShowAssociator] = useState(false);
  const [loreUpdates, setLoreUpdates] = useState<LoreUpdateSuggestion[]>([]);

  // Config for PLOT -> CHAPTER
  const [chapterCount, setChapterCount] = useState(3);
  const [wordCountInput, setWordCountInput] = useState('3000-5000');
  
  // Config for OUTLINE -> PLOT (Milestones)
  const [totalPoints, setTotalPoints] = useState(60);
  const [generateCount, setGenerateCount] = useState(5);

  if (!node) return null;

  const parent = node.parentId ? nodes.find(n => n.id === node.parentId) : null;
  const prevNode = node.prevNodeId ? nodes.find(n => n.id === node.prevNodeId) : null;
  const nextNode = nodes.find(n => n.prevNodeId === node.id);
  const colors = NODE_COLORS[node.type];
  const resources = nodes.filter(n => [NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(n.type));
  const allowedChildren = HIERARCHY_RULES[node.type];
  const canExpand = allowedChildren && allowedChildren.length > 0;
  
  const getContext = () => {
      const rootNode = nodes.find(n => n.type === NodeType.ROOT);
      const linkedIds = node.associations || [];
      const linkedNodes = nodes.filter(n => linkedIds.includes(n.id));
      let context = "";
      if (rootNode && node.type !== NodeType.ROOT) {
          context += `【世界观背景 (Bible)】：${rootNode.content}\n\n`;
      }
      context += linkedNodes.map(n => `[${n.type}] ${n.title}: ${n.summary}`).join('\n');
      return context;
  };

  const getWordCount = () => {
      return node.content.length;
  };

  // ---------------- Handlers ----------------

  const handleExpand = async () => {
    setGlobalLoading(true);
    try {
      const newNodes = await generateNodeExpansion({
        currentNode: node,
        parentContext: parent || undefined,
        prevContext: prevNode || undefined,
        globalContext: getContext(),
        settings,
        task: 'EXPAND',
        expansionConfig: node.type === NodeType.PLOT ? { chapterCount, wordCount: wordCountInput } : undefined,
        milestoneConfig: node.type === NodeType.OUTLINE ? { totalPoints, generateCount } : undefined
      });
      if (newNodes.length) onAddChildren(node.id, newNodes);
    } catch (e) { alert("生成失败"); } finally { setGlobalLoading(false); }
  };

  const handleContinue = async () => {
    setGlobalLoading(true);
    try {
      const newNodes = await generateNodeExpansion({
        currentNode: node,
        parentContext: parent || undefined,
        prevContext: node,
        nextContext: nextNode || undefined,
        globalContext: getContext(),
        settings,
        task: 'CONTINUE'
      });
      if (newNodes.length) onAddSibling(node.id, newNodes[0]);
    } catch (e) { alert("续写失败"); } finally { setGlobalLoading(false); }
  };

  const handleLogicCheck = async () => {
      setGlobalLoading(true);
      try {
          const result = await validateStoryLogic({
            currentNode: node,
            parentContext: parent || undefined,
            prevContext: prevNode || undefined,
            nextContext: nextNode || undefined,
            globalContext: getContext(),
            settings,
            task: 'EXPAND'
          });
          setLogicResult(result);
      } finally { setGlobalLoading(false); }
  };

  const handleWrite = async () => {
    setGlobalLoading(true);
    try {
      const content = await generateChapterContent({
        currentNode: node,
        parentContext: parent || undefined,
        prevContext: prevNode || undefined,
        globalContext: getContext(),
        storyContext: storyContext, // Pass the rolling summary
        settings,
        task: 'WRITE'
      });
      // Append for chapters
      onUpdate(node.id, { content: node.content + (node.content ? '\n\n' : '') + content });
    } catch (e) { alert("写作失败"); } finally { setGlobalLoading(false); }
  };

  const handlePolishContent = async () => {
      if (!polishInput) return;
      setGlobalLoading(true);
      try {
          const newText = await refineContent(node.content, polishInput, settings);
          onUpdate(node.id, { content: newText });
      } finally { setGlobalLoading(false); }
  };

  const handlePolishSummary = async () => {
      if (!summaryPolishInput) return;
      setGlobalLoading(true);
      try {
          const newText = await refineContent(node.summary, summaryPolishInput, settings);
          onUpdate(node.id, { summary: newText });
      } finally { setGlobalLoading(false); }
  };

  const handleGeneratePrompt = async () => {
      if (!genPromptIntent) return;
      setGlobalLoading(true);
      try {
          const prompt = await generateRefinementPrompt(node.type, node.summary, genPromptIntent, settings);
          setPolishInput(prompt);
          setShowPromptGen(false);
          setGenPromptIntent('');
      } finally { setGlobalLoading(false); }
  };

  const handleSyncLore = async () => {
      if (!node.content) return;
      setGlobalLoading(true);
      try {
          const linkedIds = node.associations || [];
          const linkedNodes = nodes.filter(n => linkedIds.includes(n.id));
          const suggestions = await extractLoreUpdates(node.content, linkedNodes, settings);
          setLoreUpdates(suggestions);
      } finally { setGlobalLoading(false); }
  }

  const handleSyncToSummary = () => {
      onUpdate(node.id, { summary: node.content });
      alert("已将内容同步到摘要 (复制)");
  };

  const handleSyncToContent = () => {
      onUpdate(node.id, { content: node.summary });
      alert("已将摘要同步到详情 (复制)");
  };

  const toggleAssociation = (resourceId: string) => {
      const current = node.associations || [];
      const updated = current.includes(resourceId) ? current.filter(id => id !== resourceId) : [...current, resourceId];
      onUpdate(node.id, { associations: updated });
  };

  // ---------------- UI Helpers ----------------
  
  const getTabLabel = () => {
      switch(node.type) {
          case NodeType.ROOT: return "世界观圣经 (Worldview)";
          case NodeType.OUTLINE: return "分卷/大副本规划 (Map)";
          case NodeType.PLOT: return "区域剧情细纲 (Area)";
          case NodeType.CHAPTER: return "正文写作 (Event)";
          default: return "内容编辑";
      }
  };

  const getPlaceholder = () => {
      switch(node.type) {
          case NodeType.ROOT: return "# 世界观\n这里是小说的灵魂。设定力量体系、地理历史、核心主线...";
          case NodeType.OUTLINE: return "# 大副本规划\n本卷包含哪些大地图？\n1. 新手村（XX事件）\n2. 荒原（XX BOSS）";
          case NodeType.PLOT: return "# 区域/事件集\n该区域内的关键剧情点（10+事件）。\n1. 遭遇...\n2. 获得...\n3. 战斗...";
          case NodeType.CHAPTER: return "正文开始... (需包含3个以上事件)";
          default: return "";
      }
  };

  // Correctly identify all resource types including new LOCATION and FACTION
  const isResourceNode = [NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(node.type);

  return (
    <div className="w-[500px] flex flex-col bg-slate-900 border-l border-slate-800 h-full shadow-2xl z-30">
      
      {/* Header */}
      <div className={`p-4 border-b border-slate-800 flex justify-between items-center ${colors.bg}`}>
         <div className="flex-1">
             <div className="flex items-center gap-2 mb-1">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-black/30 ${colors.text}`}>{colors.label}</span>
                {node.type === NodeType.CHAPTER && (
                    <span className="text-[10px] font-mono text-white/50 bg-black/20 px-1.5 py-0.5 rounded flex items-center gap-1">
                        <TypeIcon size={10} /> {getWordCount()} 字
                    </span>
                )}
             </div>
             <input 
                value={node.title} 
                onChange={(e) => onUpdate(node.id, { title: e.target.value })}
                className="w-full bg-transparent border-none p-0 text-white font-bold text-lg focus:ring-0"
            />
         </div>
         <button onClick={onClose} className="text-white/60 hover:text-white"><X size={20}/></button>
      </div>

      {/* Tabs */}
      {!isResourceNode && (
          <div className="flex border-b border-slate-800 bg-slate-950">
            <button 
              onClick={() => setActiveTab('meta')}
              className={`flex-1 py-3 text-xs font-bold uppercase flex items-center justify-center gap-2 transition ${activeTab === 'meta' ? 'text-blue-400 border-b-2 border-blue-500 bg-slate-900' : 'text-slate-500 hover:text-slate-300'}`}
            >
                <Layout size={14} /> 结构与配置
            </button>
            <button 
              onClick={() => setActiveTab('editor')}
              className={`flex-1 py-3 text-xs font-bold uppercase flex items-center justify-center gap-2 transition ${activeTab === 'editor' ? 'text-blue-400 border-b-2 border-blue-500 bg-slate-900' : 'text-slate-500 hover:text-slate-300'}`}
            >
                <PenTool size={14} /> {getTabLabel()}
            </button>
          </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-900 relative">
        
        {/* --- TAB: META & STRUCTURE --- */}
        {(activeTab === 'meta' || isResourceNode) && (
            <div className="p-6 space-y-6">
                
                {/* 1. Summary (Card Face) */}
                <div className="space-y-2">
                    <div className="flex justify-between items-end">
                        <label className="text-[10px] font-bold text-slate-500 uppercase flex justify-between">
                            <span>卡片摘要 (Summary)</span>
                        </label>
                        {!isResourceNode && (
                             <button onClick={handleSyncToContent} className="text-[10px] bg-slate-800 hover:bg-slate-700 text-blue-400 hover:text-blue-300 border border-slate-700 px-2 py-0.5 rounded flex items-center gap-1 transition">
                                同步到右侧详情 <ArrowRightCircle size={10} />
                            </button>
                        )}
                    </div>
                    <textarea 
                        value={node.summary} 
                        onChange={(e) => onUpdate(node.id, { summary: e.target.value })}
                        className="w-full bg-slate-800 border border-slate-700 rounded-xl p-3 text-slate-200 focus:border-blue-500 focus:outline-none resize-none text-sm h-32"
                        placeholder="简短描述..."
                    />
                    {!isResourceNode && (
                        <div className="flex justify-between mt-1 items-center bg-slate-950/50 p-1.5 rounded-lg border border-slate-800">
                            {/* Summary Polish Tool */}
                            <div className="flex-1 flex gap-2 items-center">
                                <span className="text-[9px] text-slate-500 uppercase font-bold shrink-0">润色摘要:</span>
                                <input 
                                    value={summaryPolishInput} 
                                    onChange={e => setSummaryPolishInput(e.target.value)}
                                    placeholder="输入指令..."
                                    className="flex-1 bg-slate-800 border-none rounded px-2 py-0.5 text-[10px] text-slate-300 focus:ring-0"
                                />
                                <button onClick={handlePolishSummary} className="bg-purple-900/50 hover:bg-purple-900 text-purple-300 p-1 rounded text-[10px]">
                                    <Wand2 size={10}/>
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* 2. Context / Associations */}
                {!isResourceNode && node.type !== NodeType.ROOT && (
                    <div className="space-y-2">
                         <div className="flex items-center justify-between">
                             <label className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-2">
                                 <LinkIcon size={12}/> 关联上下文 (Context)
                             </label>
                             <button onClick={() => setShowAssociator(!showAssociator)} className="text-[10px] text-blue-400 hover:underline">
                                 {showAssociator ? '完成' : '添加关联'}
                             </button>
                         </div>
                         <div className="flex flex-wrap gap-2">
                             {(node.associations || []).map(id => {
                                 const res = resources.find(r => r.id === id);
                                 if (!res) return null;
                                 return (
                                     <span key={id} className="text-xs bg-slate-800 border border-slate-700 px-2 py-1 rounded-full text-slate-300 flex items-center gap-1">
                                         <span className={`w-1.5 h-1.5 rounded-full ${res.type === NodeType.CHARACTER ? 'bg-pink-500' : (res.type === NodeType.ITEM ? 'bg-indigo-500' : (res.type === NodeType.FACTION ? 'bg-orange-500' : 'bg-teal-500'))}`}></span>
                                         {res.title}
                                         <button onClick={() => toggleAssociation(id)} className="hover:text-red-400 ml-1"><X size={10}/></button>
                                     </span>
                                 )
                             })}
                         </div>
                         {showAssociator && (
                             <div className="p-2 bg-slate-950 border border-slate-800 rounded-lg max-h-40 overflow-y-auto grid grid-cols-2 gap-2 mt-2">
                                 {resources.map(res => (
                                     <div key={res.id} onClick={() => toggleAssociation(res.id)} className={`text-xs p-2 rounded cursor-pointer border ${node.associations?.includes(res.id) ? 'border-blue-500 bg-blue-900/20' : 'border-transparent hover:bg-slate-800'}`}>
                                         {res.title}
                                     </div>
                                 ))}
                             </div>
                         )}
                    </div>
                )}

                {/* 3. Logic Review */}
                {!isResourceNode && node.type !== NodeType.ROOT && logicResult && (
                    <div className={`p-3 rounded-lg border text-xs ${logicResult.valid ? 'bg-emerald-900/20 border-emerald-800' : 'bg-red-900/20 border-red-800'}`}>
                        <div className="font-bold mb-1 flex items-center gap-2">
                            {logicResult.valid ? <ShieldCheck size={14}/> : <AlertTriangle size={14}/>}
                            逻辑评分: {logicResult.score}
                        </div>
                        <ul className="list-disc list-inside space-y-1 opacity-80">
                            {logicResult.issues.map((s, i) => <li key={i} className="text-red-300">{s}</li>)}
                            {logicResult.suggestions.map((s, i) => <li key={i} className="text-emerald-300">{s}</li>)}
                        </ul>
                    </div>
                )}

                {/* 4. Generation Actions */}
                {!isResourceNode && (
                    <div className="pt-4 border-t border-slate-800 space-y-4">
                        {/* Only show logic check for non-ROOT nodes */}
                        {node.type !== NodeType.ROOT && (
                            <button onClick={handleLogicCheck} className="w-full bg-slate-800 border border-slate-700 py-2 rounded text-xs text-slate-300 hover:bg-slate-700 flex justify-center gap-2">
                                <ShieldCheck size={14} className="text-amber-500"/> 事件密度与逻辑自检
                            </button>
                        )}

                        <div className="grid grid-cols-1 gap-3">
                            {/* Expand Logic */}
                            {canExpand ? (
                                <div className="bg-slate-800/50 p-3 rounded-xl border border-slate-700 space-y-3">
                                    <div className="text-[10px] font-bold text-slate-500 uppercase text-center mb-1">向下细化 (Expand)</div>
                                    
                                    {/* Config: Outline -> Plot (Milestones) */}
                                    {node.type === NodeType.OUTLINE && (
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-[9px] text-slate-500 block">本卷剧情/事件总量</label>
                                                <input type="number" value={totalPoints} onChange={e => setTotalPoints(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-600 rounded text-xs px-2 py-1" />
                                            </div>
                                            <div>
                                                <label className="text-[9px] text-slate-500 block">生成区域(Plot)数量</label>
                                                <input type="number" value={generateCount} onChange={e => setGenerateCount(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-600 rounded text-xs px-2 py-1" />
                                            </div>
                                            <div className="col-span-2 text-[9px] text-slate-500 italic">
                                                *注: 1个Plot节点 = 1个特定区域（隐含10+事件）
                                            </div>
                                        </div>
                                    )}

                                    {/* Config: Plot -> Chapter */}
                                    {node.type === NodeType.PLOT && (
                                        <div className="grid grid-cols-2 gap-2">
                                             <div>
                                                <label className="text-[9px] text-slate-500 block">拆分章节数</label>
                                                <input type="number" value={chapterCount} onChange={e => setChapterCount(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-600 rounded text-xs px-2 py-1" />
                                            </div>
                                            <div>
                                                <label className="text-[9px] text-slate-500 block">单章字数</label>
                                                <input type="text" value={wordCountInput} onChange={e => setWordCountInput(e.target.value)} className="w-full bg-slate-900 border border-slate-600 rounded text-xs px-2 py-1" />
                                            </div>
                                            <div className="col-span-2 text-[9px] text-slate-500 italic text-amber-500/80">
                                                *注: 每章将强制包含 3-4 个完整事件
                                            </div>
                                        </div>
                                    )}

                                    <button onClick={handleExpand} className="w-full bg-blue-900/30 hover:bg-blue-900/50 border border-blue-800 text-blue-200 py-2 rounded-lg flex items-center justify-center gap-2 text-xs transition">
                                        <ListTree size={16}/> 
                                        {node.type === NodeType.OUTLINE ? '生成区域剧情锚点' : '拆分章节 (高密度)'}
                                    </button>
                                </div>
                            ) : (
                                <div className="text-center text-xs text-slate-600 py-2 border border-dashed border-slate-800 rounded">已是叶子节点</div>
                            )}

                            {/* Continue Logic - Hidden for ROOT */}
                            {node.type !== NodeType.ROOT && (
                                <button onClick={handleContinue} className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 py-3 rounded-xl flex items-center justify-center gap-2 text-xs text-slate-300 transition">
                                    {nextNode ? <GitMerge size={16} className="text-amber-500"/> : <ArrowRightCircle size={16} className="text-emerald-500"/>}
                                    {nextNode ? '插入地图过渡节点' : '推进下一事件 (Next)'}
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        )}

        {/* --- TAB: EDITOR (RIGHT COLUMN) --- */}
        {activeTab === 'editor' && !isResourceNode && (
            <div className="h-full flex flex-col">
                {/* Editor Toolbar */}
                <div className="p-2 border-b border-slate-800 bg-slate-950 flex items-center justify-between">
                    <span className="text-[10px] text-slate-500 uppercase font-bold pl-2">{getTabLabel()}</span>
                    
                    <div className="flex gap-2">
                         {/* Sync Button: Hidden for Chapters to protect Outline integrity */}
                         {node.type !== NodeType.CHAPTER && (
                             <button 
                                onClick={handleSyncToSummary}
                                className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 px-2 py-1 rounded flex items-center gap-1"
                                title="复制当前内容到左侧摘要"
                             >
                                <ArrowLeft size={10} /> 同步到摘要
                             </button>
                         )}

                         {node.type === NodeType.CHAPTER && (
                            <button onClick={handleWrite} className="text-xs bg-amber-600 hover:bg-amber-500 text-white px-3 py-1 rounded flex items-center gap-2">
                                <Sparkles size={12}/> AI 续写 (3事件)
                            </button>
                        )}
                    </div>
                </div>

                {/* Main Text Area */}
                <textarea 
                    value={node.content} 
                    onChange={(e) => onUpdate(node.id, { content: e.target.value })}
                    className="flex-1 bg-slate-900 p-6 text-slate-300 focus:outline-none resize-none text-base leading-relaxed font-serif custom-scrollbar"
                    placeholder={getPlaceholder()}
                />

                {/* Refine / Polish Tools */}
                <div className="p-4 border-t border-slate-800 bg-slate-950 space-y-3 relative">
                    {/* Prompt Generator Popover */}
                    {showPromptGen && (
                        <div className="absolute bottom-full left-4 right-4 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-4 z-50 mb-2 animate-in slide-in-from-bottom-2">
                            <div className="flex justify-between items-center mb-3">
                                <span className="text-xs font-bold text-indigo-400 flex items-center gap-2"><BrainCircuit size={14}/> 智能指令生成器 (AI Prompt Gen)</span>
                                <button onClick={() => setShowPromptGen(false)}><X size={14} className="text-slate-500 hover:text-white"/></button>
                            </div>
                            
                            <div className="flex gap-2 mb-2 overflow-x-auto pb-1">
                                {['增加事件密度', '强化地图描写', '加快副本节奏', '优化对话冲突', '制造悬念'].map(tag => (
                                    <button 
                                        key={tag}
                                        onClick={() => setGenPromptIntent(tag)}
                                        className="text-[10px] bg-slate-800 hover:bg-indigo-900 text-slate-300 hover:text-indigo-200 px-2 py-1 rounded border border-slate-700 whitespace-nowrap"
                                    >
                                        {tag}
                                    </button>
                                ))}
                            </div>

                            <input 
                                value={genPromptIntent}
                                onChange={e => setGenPromptIntent(e.target.value)}
                                placeholder="输入模糊意图 (例如: 这里的战斗不够刺激，需要更多交互...)"
                                className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-xs text-white focus:outline-none focus:border-indigo-500 mb-3"
                                autoFocus
                            />
                            <button 
                                onClick={handleGeneratePrompt} 
                                disabled={!genPromptIntent}
                                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs py-2 rounded font-bold flex items-center justify-center gap-2"
                            >
                                <Sparkles size={12}/> 生成结构化 Prompt
                            </button>
                        </div>
                    )}

                    <div className="flex gap-2 items-center">
                        {/* Prompt Gen Toggle */}
                        <button 
                            onClick={() => setShowPromptGen(!showPromptGen)} 
                            className={`p-2 rounded border transition ${showPromptGen ? 'bg-indigo-900 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-indigo-400 hover:text-white'}`}
                            title="AI 智能指令生成器"
                        >
                            <BrainCircuit size={16}/>
                        </button>
                        
                        <input 
                            value={polishInput}
                            onChange={e => setPolishInput(e.target.value)}
                            placeholder={node.type === NodeType.ROOT ? "输入润色指令..." : "输入润色/修改指令..."}
                            className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500"
                        />
                        <button 
                            onClick={handlePolishContent} 
                            disabled={!polishInput}
                            className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white p-2 rounded shadow-lg shadow-purple-900/20"
                            title="执行润色"
                        >
                            <Wand2 size={16}/>
                        </button>
                    </div>

                    {/* Lore Sync (Only Chapter) */}
                    {node.type === NodeType.CHAPTER && (
                        <div>
                             <button onClick={handleSyncLore} className="w-full flex justify-center gap-2 text-xs text-indigo-400 hover:text-indigo-300 py-1 mt-1 opacity-80 hover:opacity-100 transition">
                                 <RefreshCw size={12}/> 扫描正文并同步设定变更
                             </button>
                             {loreUpdates.length > 0 && (
                                 <div className="mt-2 space-y-2 max-h-32 overflow-y-auto custom-scrollbar">
                                     {loreUpdates.map((u, i) => (
                                         <div key={i} className="bg-slate-900 border border-indigo-900 p-2 rounded text-xs text-slate-400 animate-in slide-in-from-left-2">
                                             <span className="text-indigo-400 block mb-1 font-bold">更新: {nodes.find(n=>n.id===u.targetId)?.title}</span>
                                             <div className="mb-2 italic opacity-80">"{u.reason}"</div>
                                             <button onClick={() => { onSyncLoreUpdates([u]); setLoreUpdates(p => p.filter((_, idx) => idx !== i)); }} className="block w-full bg-indigo-900/50 hover:bg-indigo-900 text-indigo-200 text-center py-1 rounded font-bold">
                                                 确认应用更新
                                             </button>
                                         </div>
                                     ))}
                                 </div>
                             )}
                        </div>
                    )}
                </div>
            </div>
        )}

      </div>
      
      {/* Footer */}
      <div className="p-3 border-t border-slate-800 bg-slate-950 flex justify-between items-center text-[10px] text-slate-600">
          <span className="font-mono opacity-50">{node.id}</span>
          <button onClick={() => onDelete(node.id)} className="text-red-500 hover:bg-red-900/20 px-2 py-1 rounded flex items-center gap-1 transition"><Trash2 size={12}/> 删除节点</button>
      </div>

    </div>
  );
};

export default EditorPanel;
