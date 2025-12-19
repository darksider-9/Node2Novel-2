
import React, { useState } from 'react';
import { NodeData, NodeType, AppSettings, LogicValidationResult, LoreUpdateSuggestion, MilestoneConfig } from '../types';
import { Sparkles, X, Trash2, BookOpen, FileText, ShieldCheck, AlertTriangle, Wand2, RefreshCw, Link as LinkIcon, UserPlus, ArrowRightCircle, ListTree, GitMerge, Layout, Globe, PenTool, Hash, ArrowLeft, BrainCircuit, Type as TypeIcon, SearchCheck, Layers, PlusCircle, CheckCircle, Loader2 } from 'lucide-react';
import { generateChapterContent, generateNodeExpansion, validateStoryLogic, refineContent, extractLoreUpdates, generateRefinementPrompt, analyzeAndGenerateFix, analyzeContentCoverage, validateEndingStyle } from '../services/geminiService';
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
  
  // NEW: Coverage Analysis Result State
  const [coverageResult, setCoverageResult] = useState<{ missingNodes: { title: string, summary: string, insertAfterId: string | null }[] } | null>(null);
  
  // Local Loading State for precise feedback
  const [processStatus, setProcessStatus] = useState<string>('');

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
  const children = nodes.filter(n => n.parentId === node.id); // For coverage check
  
  // Safe access for colors
  const colors = NODE_COLORS[node.type] || NODE_COLORS[NodeType.PLOT];
  
  const resources = nodes.filter(n => [NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(n.type));
  
  // Safe access for allowed children
  const allowedChildren = HIERARCHY_RULES[node.type] || [];
  const canExpand = allowedChildren.length > 0;
  
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
      return (node.content || "").length;
  };

  // Helper: Calculate Global Chapter Index for "Golden Three" logic
  const calculateGlobalIndex = () => {
      // Traverse from root to find all chapters in order
      const root = nodes.find(n => n.type === NodeType.ROOT);
      if (!root) return 1;

      const allChapters: string[] = [];
      const traverse = (parentId: string) => {
          const children = nodes.filter(n => n.parentId === parentId);
          // Sort by Y to approximate visual/chronological order
          children.sort((a,b) => a.y - b.y);
          children.forEach(child => {
              if (child.type === NodeType.CHAPTER) {
                  allChapters.push(child.id);
              } else {
                  traverse(child.id);
              }
          });
      };
      traverse(root.id);
      return allChapters.indexOf(node.id) + 1;
  };

  // Helper: Sanitize text (remove markdown blocks if any)
  const sanitizeText = (text: string) => {
      const codeBlockRegex = /^```(?:markdown)?\s*([\s\S]*?)\s*```$/i;
      const match = text.match(codeBlockRegex);
      return match && match[1] ? match[1].trim() : text.trim();
  };

  // ---------------- Handlers ----------------

  // NEW: Content Coverage Analysis
  const handleCoverageAnalysis = async () => {
      if (children.length === 0) {
          alert("该功能仅在已有子节点时可用，用于检查子节点内容是否全面覆盖了父级大纲。");
          return;
      }
      setGlobalLoading(true);
      try {
          const result = await analyzeContentCoverage(node, children, settings);
          if (result.missingNodes.length === 0) {
              alert("分析完成：子节点已完美覆盖父级内容！");
          } else {
              // Show Modal instead of confirm
              setCoverageResult(result);
          }
      } catch (e) {
          alert("分析失败");
      } finally {
          setGlobalLoading(false);
      }
  };

  const handleApplyCoverageFix = () => {
      if (!coverageResult) return;
      coverageResult.missingNodes.forEach(missing => {
          if (missing.insertAfterId) {
              onAddSibling(missing.insertAfterId, { title: missing.title, summary: missing.summary });
          } else {
              onAddChildren(node.id, [{ title: missing.title, summary: missing.summary }]);
          }
      });
      setCoverageResult(null);
  };

  // NEW: Chapter Outline Optimization
  const handleOptimizeChapterOutline = async () => {
      setGlobalLoading(true);
      try {
          const context = getContext();
          const instruction = await analyzeAndGenerateFix(node, context, "", 2000, "", settings);
          
          if (instruction.includes("PASS")) {
              alert("当前章节细纲已符合高质量标准，无需修改。");
              return;
          }
          
          // Apply fix
          const rawResult = await refineContent(node.summary, instruction, settings, context);
          onUpdate(node.id, { summary: rawResult.trim() });
      } catch (e) {
          alert("优化失败");
      } finally {
          setGlobalLoading(false);
      }
  };

  const handleExpand = async () => {
    setGlobalLoading(true);
    setProcessStatus(node.type === NodeType.OUTLINE ? '正在规划关键剧情锚点...' : '正在生成...');
    try {
      // 1. Determine Configuration
      const isVolumeExpansion = node.type === NodeType.OUTLINE;
      
      // CONFIG FOR PLOT -> CHAPTER
      const plotConfig = node.type === NodeType.PLOT ? { chapterCount, wordCount: wordCountInput } : undefined;
      
      // CONFIG FOR OUTLINE -> PLOT
      // Explicitly set strategy to 'spanning' for OUTLINE to get Keyframes first
      const outlineConfig: MilestoneConfig | undefined = isVolumeExpansion ? { 
          totalPoints, 
          generateCount, 
          strategy: 'spanning' 
      } : undefined;

      // 2. Initial Generation (Keyframes or Chapters)
      const keyframeNodes = await generateNodeExpansion({
        currentNode: node,
        parentContext: parent || undefined,
        prevContext: prevNode || undefined,
        globalContext: getContext(),
        settings,
        task: 'EXPAND',
        expansionConfig: plotConfig,
        milestoneConfig: outlineConfig
      });

      // 3. Logic for Volume Infill (Keyframe + Infill Strategy)
      if (isVolumeExpansion && keyframeNodes.length >= 2 && totalPoints > keyframeNodes.length) {
           setProcessStatus('正在填充剧情空隙 (Infill)...');
           
           const finalSequence: Partial<NodeData>[] = [];
           const intervals = keyframeNodes.length - 1;
           const remainingToFill = totalPoints - keyframeNodes.length;
           
           if (remainingToFill > 0) {
               const perGap = Math.floor(remainingToFill / intervals);
               let remainder = remainingToFill % intervals;

               for (let i = 0; i < intervals; i++) {
                   const startK = keyframeNodes[i];
                   const endK = keyframeNodes[i+1];
                   
                   // Push Start Keyframe
                   finalSequence.push(startK);

                   // Calculate gap count for this interval
                   const countForGap = perGap + (remainder > 0 ? 1 : 0);
                   if (remainder > 0) remainder--;

                   if (countForGap > 0) {
                       setProcessStatus(`填充锚点间隙 ${i+1}/${intervals}...`);
                       
                       // Mock NodeData for context (needs minimal valid props)
                       const mockStartNode = { ...node, ...startK, id: 'temp_start', type: NodeType.PLOT } as NodeData;
                       const mockEndNode = { ...node, ...endK, id: 'temp_end', type: NodeType.PLOT } as NodeData;

                       const infillNodes = await generateNodeExpansion({
                            currentNode: mockStartNode,
                            parentContext: node, // Parent is the Volume
                            prevContext: mockStartNode,
                            nextContext: mockEndNode,
                            globalContext: getContext(),
                            settings,
                            task: 'CONTINUE', // Infill task
                            milestoneConfig: { totalPoints: countForGap, generateCount: countForGap, strategy: 'linear' }
                       });
                       
                       finalSequence.push(...infillNodes);
                   }
               }
               // Push Last Keyframe
               finalSequence.push(keyframeNodes[keyframeNodes.length - 1]);
               
               if (finalSequence.length > 0) {
                   onAddChildren(node.id, finalSequence);
               }
           } else {
               // No filling needed (e.g. totalPoints matches generateCount)
               onAddChildren(node.id, keyframeNodes);
           }
      } else {
          // Standard behavior for other types or if no fill needed
          if (keyframeNodes.length) onAddChildren(node.id, keyframeNodes);
      }

    } catch (e) { 
        alert("生成失败"); 
        console.error(e);
    } finally { 
        setGlobalLoading(false); 
        setProcessStatus('');
    }
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

  // --- UPGRADED: Full Pipeline Generation (Identical to AutoDraftAgent) ---
  const handleWrite = async () => {
    setGlobalLoading(true);
    setProcessStatus('正在构思初稿...');
    try {
      const globalIndex = calculateGlobalIndex();
      const context = getContext();

      // 1. Generate Initial Draft
      // Note: `node.summary` is already passed via `currentNode` param inside the service
      let content = await generateChapterContent({
        currentNode: node,
        parentContext: parent || undefined,
        prevContext: prevNode || undefined,
        globalContext: context,
        storyContext: storyContext,
        settings,
        task: 'WRITE',
        structuralContext: { globalChapterIndex: globalIndex }
      });
      content = sanitizeText(content);
      
      // Update intermediate state
      onUpdate(node.id, { content });

      // 2. Auto-Optimize (Quality Gate)
      setProcessStatus('正在进行主编级审稿...');
      // Mock node with new content for analysis
      const tempNode = { ...node, content: content }; 
      const instruction = await analyzeAndGenerateFix(
          tempNode, 
          context, 
          "", // resources context already in full context or skip for now
          2000, 
          "", 
          settings, 
          globalIndex === 1
      );

      if (!instruction.includes("PASS")) {
          setProcessStatus('根据审稿意见进行精修...');
          const refined = await refineContent(content, instruction, settings, context);
          content = sanitizeText(refined);
          onUpdate(node.id, { content });
      }

      // 3. Expansion Check (Length Gate)
      // Default target 2000 chars for high density
      if (content.length < 2000) {
           setProcessStatus(`篇幅不足(${content.length}/2000)，正在执行硬性扩充...`);
           const expansionInstr = `
            【正文扩充任务】
            当前内容字数：${content.length}字。
            目标字数：2000字以上。
            请保留剧情逻辑，通过增加环境描写、心理描写、动作细节和对话来扩充篇幅。是"写得更细"。
           `;
           const expanded = await refineContent(content, expansionInstr, settings, context);
           content = sanitizeText(expanded);
           onUpdate(node.id, { content });
      }

      // 4. Ending Style Check
      setProcessStatus('正在检查章节结尾风格...');
      const endingCheck = await validateEndingStyle(content, settings);
      if (!endingCheck.isValid) {
          setProcessStatus('发现违规结尾，正在重写...');
          const cutIndex = Math.max(0, content.length - 1000);
          const endingSlice = content.slice(cutIndex);
          const safeContent = content.slice(0, cutIndex);
          
          const fixInstr = `【结尾重写任务】\n**严禁出现这类描述**：\n1. **预示未来**...\n2. **总结陈词**...\n\n${endingCheck.fixInstruction}`;
          const fixedEnding = await refineContent(endingSlice, fixInstr, settings, context);
          
          content = safeContent + sanitizeText(fixedEnding);
          onUpdate(node.id, { content });
      }

      setProcessStatus('');
    } catch (e) { 
        alert("写作失败: " + e); 
    } finally { 
        setGlobalLoading(false); 
        setProcessStatus('');
    }
  };

  const handlePolishContent = async () => {
      if (!polishInput) return;
      setGlobalLoading(true);
      try {
          const newText = await refineContent(node.content || "", polishInput, settings);
          onUpdate(node.id, { content: newText });
      } finally { setGlobalLoading(false); }
  };

  const handlePolishSummary = async () => {
      if (!summaryPolishInput) return;
      setGlobalLoading(true);
      try {
          const newText = await refineContent(node.summary || "", summaryPolishInput, settings);
          onUpdate(node.id, { summary: newText });
      } finally { setGlobalLoading(false); }
  };

  const handleGeneratePrompt = async () => {
      if (!genPromptIntent) return;
      setGlobalLoading(true);
      try {
          const prompt = await generateRefinementPrompt(node.type, node.summary || "", genPromptIntent, settings);
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
    <div className="w-[500px] flex flex-col bg-slate-900 border-l border-slate-800 h-full shadow-2xl z-30 relative">
      
      {/* Coverage Report Modal */}
      {coverageResult && (
          <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-indigo-500/50 rounded-xl w-full max-w-md shadow-2xl animate-in fade-in zoom-in duration-200">
                  <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-indigo-900/20 rounded-t-xl">
                       <div className="flex items-center gap-2 text-indigo-100 font-bold">
                           <SearchCheck size={18} /> 剧情覆盖率分析报告
                       </div>
                       <button onClick={() => setCoverageResult(null)}><X size={18} className="text-slate-500 hover:text-white"/></button>
                  </div>
                  
                  <div className="p-4 max-h-[60vh] overflow-y-auto custom-scrollbar space-y-3">
                       <div className="text-xs text-slate-400 bg-slate-950 p-3 rounded border border-slate-800 leading-relaxed">
                           AI 发现当前子节点序列中存在 <strong className="text-amber-400">{coverageResult.missingNodes.length}</strong> 处潜在的剧情断层或内容缺失。建议插入以下节点以完善逻辑：
                       </div>
                       
                       {coverageResult.missingNodes.map((item, idx) => (
                           <div key={idx} className="bg-slate-800/50 border border-slate-700 p-3 rounded-lg relative hover:bg-slate-800 transition">
                               <div className="absolute top-2 right-2 text-[10px] bg-slate-700 px-2 py-0.5 rounded text-slate-300">
                                   {item.insertAfterId ? '插入位置: 指定节点后' : '插入位置: 序列开头'}
                               </div>
                               <div className="font-bold text-emerald-400 text-sm mb-1.5 flex items-center gap-2">
                                   <PlusCircle size={14}/> {item.title}
                               </div>
                               <div className="text-xs text-slate-300 leading-relaxed opacity-90">
                                   {item.summary}
                               </div>
                           </div>
                       ))}
                  </div>
                  
                  <div className="p-4 border-t border-slate-800 flex gap-3 bg-slate-950/50 rounded-b-xl">
                      <button onClick={() => setCoverageResult(null)} className="flex-1 py-2 text-xs text-slate-400 hover:text-white transition bg-slate-800 hover:bg-slate-700 rounded-lg">忽略建议</button>
                      <button onClick={handleApplyCoverageFix} className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-2 shadow-lg shadow-indigo-900/20">
                          <CheckCircle size={14} /> 一键自动插入 ({coverageResult.missingNodes.length})
                      </button>
                  </div>
              </div>
          </div>
      )}
      
      {/* Process Status Overlay (When Manually Generating) */}
      {processStatus && (
          <div className="absolute top-16 left-4 right-4 z-50 bg-indigo-900/90 text-indigo-100 p-3 rounded-lg text-xs font-bold shadow-xl border border-indigo-500/50 flex items-center justify-center gap-3 animate-pulse">
              <Loader2 size={16} className="animate-spin"/>
              {processStatus}
          </div>
      )}

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

                {/* NEW: Coverage Check Button (Visible if has children) */}
                {children.length > 0 && (
                    <button 
                        onClick={handleCoverageAnalysis} 
                        className="w-full py-2.5 bg-indigo-900/30 hover:bg-indigo-900/50 border border-indigo-800 text-indigo-300 rounded-lg flex items-center justify-center gap-2 text-xs transition"
                    >
                        <SearchCheck size={16} /> 智能内容覆盖率分析 (审计断层)
                    </button>
                )}

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
                        
                        {/* CHAPTER WRITING BUTTON (Explicitly here for leaf nodes) */}
                        {node.type === NodeType.CHAPTER && (
                             <div className="bg-amber-900/10 border border-amber-900/50 p-3 rounded-xl space-y-2">
                                 <div className="text-[10px] font-bold text-amber-500 uppercase flex items-center gap-1">
                                     <Sparkles size={12}/> 核心写作 (AI Writer)
                                 </div>
                                 {/* NEW: Outline Optimizer */}
                                 <button onClick={handleOptimizeChapterOutline} className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 py-2 rounded-lg text-xs text-blue-400 flex justify-center gap-2 transition">
                                     <Layers size={14} /> 一键优化本章细纲
                                 </button>
                                 <div className="text-[10px] text-slate-400 mb-2">
                                     {prevNode ? `将自动衔接前章: ${prevNode.title}` : '当前为首章'}
                                 </div>
                                 <button onClick={handleWrite} className="w-full bg-gradient-to-r from-amber-700 to-orange-700 hover:from-amber-600 hover:to-orange-600 text-white font-bold py-2.5 rounded-lg flex items-center justify-center gap-2 text-xs shadow-lg shadow-amber-900/20 transition">
                                     <PenTool size={14} /> 生成正文 (初稿+精修+质检)
                                 </button>
                             </div>
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
                            ) : null}

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
                                <Sparkles size={12}/> AI 续写 (接龙)
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
