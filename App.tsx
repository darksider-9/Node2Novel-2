
import React, { useState, useEffect, useRef } from 'react';
import { NodeData, NodeType, AppSettings, LoreUpdateSuggestion, ViewMode, AutoDraftConfig, AutoDraftStatus } from './types';
import { DEFAULT_SETTINGS } from './constants';
import Canvas from './components/Canvas';
import EditorPanel from './components/EditorPanel';
import { Sidebar } from './components/Sidebar';
import WelcomeScreen from './components/WelcomeScreen';
import AutoDraftModal from './components/AutoDraftModal'; // Import new component
import { optimizeSystemInstruction, generateInitialWorldview, autoExtractWorldInfo } from './services/geminiService';
import { AutoDraftAgent } from './services/autoDraftAgent'; // Import new agent
import { Loader2, StopCircle, Download, AlertCircle, CheckCircle, X } from 'lucide-react';

const generateId = () => Math.random().toString(36).substr(2, 9);

// --- Layout Logic ---
const applyAutoLayout = (nodes: NodeData[], rootId: string): NodeData[] => {
    // Only layout tree structure (Root -> Outline -> Plot -> Chapter)
    // Resource nodes are ignored in this pass
    
    const tree: Record<string, string[]> = {};
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    
    nodes.forEach(n => {
        if(n.parentId) {
            if(!tree[n.parentId]) tree[n.parentId] = [];
            tree[n.parentId].push(n.id);
        }
    });

    // Sort children by order in parent's childrenIds to allow manual reordering if needed in future
    // For now, we rely on the order in the array which usually matches creation
    
    const NODE_WIDTH = 224;
    const GAP_X = 100;
    const GAP_Y = 40;
    const NODE_HEIGHT = 160; 

    let globalYCounter = 300; // Starting Y

    const layoutRecursive = (nodeId: string, depth: number): { top: number, bottom: number } => {
        const node = nodeMap.get(nodeId);
        if(!node) return { top: 0, bottom: 0 };
        
        // 1. Position X based on depth
        // Only update X if it's a story node. Resources have their own columns.
        if (![NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(node.type)) {
             node.x = 100 + (depth * (NODE_WIDTH + GAP_X));
        }

        const children = tree[nodeId] || [];
        const isCollapsed = node.collapsed;
        
        if (isCollapsed || children.length === 0) {
            // Leaf or collapsed node: takes up one slot
            node.y = globalYCounter;
            const top = globalYCounter;
            const bottom = globalYCounter + NODE_HEIGHT;
            
            // Only increment global Y for this branch's "leaf" space
            globalYCounter += NODE_HEIGHT + GAP_Y;
            return { top, bottom };
        } else {
            // Expanded parent: Place children first
            let firstChildTop = Infinity;
            let lastChildBottom = -Infinity;
            
            // Re-order children based on node.childrenIds to keep consistent sequence
            const sortedChildrenIds = node.childrenIds.filter(id => tree[nodeId]?.includes(id));
            const childIdsToProcess = sortedChildrenIds.length > 0 ? sortedChildrenIds : children;

            childIdsToProcess.forEach(childId => {
                const { top, bottom } = layoutRecursive(childId, depth + 1);
                if (top < firstChildTop) firstChildTop = top;
                if (bottom > lastChildBottom) lastChildBottom = bottom;
            });
            
            // Parent is centered relative to children
            // Center point of children bounds
            const childrenCenterY = (firstChildTop + (lastChildBottom - NODE_HEIGHT)) / 2; // Roughly center
            node.y = childrenCenterY;
            
            return { top: node.y, bottom: node.y + NODE_HEIGHT };
        }
    };

    layoutRecursive(rootId, 0);
    return Array.from(nodeMap.values());
};

const App: React.FC = () => {
  const [nodes, setNodes] = useState<NodeData[]>([]); // Start empty
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  
  // App States
  const [isInitialized, setIsInitialized] = useState(false);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [backgroundProcessing, setBackgroundProcessing] = useState(false); 
  const [viewMode, setViewMode] = useState<ViewMode>('story'); 

  // Auto Draft States
  const [showAutoDraftModal, setShowAutoDraftModal] = useState(false);
  const [showStatusOverlay, setShowStatusOverlay] = useState(false); // NEW: Controls overlay visibility independent of active state
  const [autoDraftStatus, setAutoDraftStatus] = useState<AutoDraftStatus>({ isActive: false, currentStage: '', progress: 0, logs: [] });
  const autoDraftAgentRef = useRef<AutoDraftAgent | null>(null);

  // Nodes Ref for Async Agent access
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // --- Persistence Logic ---
  useEffect(() => {
      // Load on mount
      const savedNodes = localStorage.getItem('novelweaver_nodes');
      const savedSettings = localStorage.getItem('novelweaver_settings');
      const savedInit = localStorage.getItem('novelweaver_init');

      if (savedNodes) setNodes(JSON.parse(savedNodes));
      if (savedSettings) setSettings(JSON.parse(savedSettings));
      if (savedInit === 'true') setIsInitialized(true);
  }, []);

  useEffect(() => {
      // Auto-save on change
      if (isInitialized) {
          localStorage.setItem('novelweaver_nodes', JSON.stringify(nodes));
          localStorage.setItem('novelweaver_settings', JSON.stringify(settings));
          localStorage.setItem('novelweaver_init', 'true');
      }
  }, [nodes, settings, isInitialized]);
  
  // Helper to trigger layout update safely
  const updateLayout = (currentNodes: NodeData[]) => {
      const root = currentNodes.find(n => n.type === NodeType.ROOT);
      if (root) {
          return applyAutoLayout(currentNodes, root.id);
      }
      return currentNodes;
  };

  // --- Background World Extraction ---
  // Fix: Accepts settings override to handle initial creation
  const triggerWorldAnalysis = async (text: string, sourceNodeId: string, settingsOverride?: AppSettings) => {
      if (backgroundProcessing) return; // Debounce roughly
      setBackgroundProcessing(true);
      console.log("Starting background world analysis...");

      try {
          // Get all current resource nodes
          const resourceNodes = nodes.filter(n => [NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(n.type));
          
          // Use override if provided (e.g. during initial setup)
          const currentSettings = settingsOverride || settings;
          
          const analysis = await autoExtractWorldInfo(text, resourceNodes, currentSettings);
          
          if (analysis.newResources.length > 0 || analysis.updates.length > 0 || analysis.mentionedIds.length > 0) {
              setNodes(prev => {
                  let updatedNodes = [...prev];
                  const messages: string[] = [];
                  
                  // Helper to get next Y position for a column
                  const getNextY = (type: NodeType) => {
                      const count = updatedNodes.filter(n => n.type === type).length;
                      return 100 + (count * 250); // Start at Y=100, spacing 250
                  };

                  // 1. Create New Resources with Auto Layout
                  analysis.newResources.forEach(res => {
                      if (!updatedNodes.some(n => n.title === res.title && n.type === res.type)) {
                          const newId = generateId();
                          const type = res.type as NodeType;
                          
                          // Column Layout Logic for Resource Mode
                          let startX = 0;
                          if (type === NodeType.CHARACTER) startX = 0;
                          if (type === NodeType.LOCATION) startX = 300;
                          if (type === NodeType.FACTION) startX = 600;
                          if (type === NodeType.ITEM) startX = 900;
                          
                          updatedNodes.push({
                              id: newId,
                              type: type, 
                              title: res.title,
                              summary: res.summary,
                              content: res.summary,
                              x: startX, 
                              y: getNextY(type), // Stack vertically in column
                              parentId: null,
                              childrenIds: [],
                              collapsed: false,
                              associations: []
                          });
                          messages.push(`自动建卡: ${res.title}`);
                          analysis.mentionedIds.push(newId); 
                      }
                  });

                  // 2. Update Existing Resources
                  analysis.updates.forEach(upd => {
                      const targetIndex = updatedNodes.findIndex(n => n.id === upd.id);
                      if (targetIndex !== -1) {
                          updatedNodes[targetIndex] = {
                              ...updatedNodes[targetIndex],
                              summary: upd.newSummary
                          };
                          messages.push(`自动更新: ${updatedNodes[targetIndex].title} (${upd.changeLog})`);
                      }
                  });

                  // 3. Update Associations (AND BUBBLE UP TO PARENT)
                  if (analysis.mentionedIds.length > 0) {
                      const sourceIndex = updatedNodes.findIndex(n => n.id === sourceNodeId);
                      if (sourceIndex !== -1) {
                          const currentAssoc = updatedNodes[sourceIndex].associations || [];
                          const newAssoc = Array.from(new Set([...currentAssoc, ...analysis.mentionedIds]));
                          updatedNodes[sourceIndex] = {
                              ...updatedNodes[sourceIndex],
                              associations: newAssoc
                          };

                          // --- PROPAGATION LOGIC START ---
                          // If current node (Chapter/Plot) has new resources, propagate to Parent (Plot/Outline)
                          const parentId = updatedNodes[sourceIndex].parentId;
                          if (parentId) {
                               const parentIndex = updatedNodes.findIndex(p => p.id === parentId);
                               if (parentIndex !== -1) {
                                   const parentAssoc = updatedNodes[parentIndex].associations || [];
                                   const mergedParentAssoc = Array.from(new Set([...parentAssoc, ...newAssoc]));
                                   updatedNodes[parentIndex] = {
                                       ...updatedNodes[parentIndex],
                                       associations: mergedParentAssoc
                                   };
                               }
                          }
                          // --- PROPAGATION LOGIC END ---
                      }
                  }
                  
                  if(messages.length > 0) {
                       console.log("World Updates:", messages);
                  }

                  return updatedNodes;
              });
          }
      } catch (e) {
          console.error("Background analysis failed", e);
      } finally {
          setBackgroundProcessing(false);
      }
  };

  // --- Import Logic ---
  const handleImportProject = (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
          try {
              const content = e.target?.result as string;
              if (!content) {
                  alert("文件内容为空");
                  return;
              }
              const data = JSON.parse(content);
              
              if (data.nodes && Array.isArray(data.nodes)) {
                  const root = data.nodes.find((n: NodeData) => n.type === NodeType.ROOT);
                  const title = root ? root.title : '未命名项目';
                  
                  const shouldConfirm = isInitialized;
                  if(!shouldConfirm || confirm(`准备导入项目 "${title}"。\n这将覆盖当前未保存的进度，确定吗？`)) {
                      // Apply layout on import
                      const laidOutNodes = root ? applyAutoLayout(data.nodes, root.id) : data.nodes;
                      setNodes(laidOutNodes);

                      if (data.settings) {
                          setSettings(prev => ({
                              ...prev,
                              ...data.settings,
                              apiKey: data.settings.apiKey || prev.apiKey || ''
                          }));
                      }
                      if (data.autoDraftLogs) {
                           setAutoDraftStatus(prev => ({ ...prev, logs: data.autoDraftLogs, currentStage: '已导入备份日志' }));
                      }
                      setIsInitialized(true);
                  }
              } else {
                  alert("文件格式无效：缺少 nodes 数据");
              }
          } catch (err) {
              console.error(err);
              alert("读取文件失败，请确保是有效的 JSON 备份文件");
          }
      };
      reader.readAsText(file);
  };

  // --- Export Logic ---
  const handleExportProject = () => {
      const root = nodes.find(n => n.type === NodeType.ROOT);
      const title = root ? root.title : 'NovelWeaver_Backup';
      const data = {
          version: '2.0',
          timestamp: new Date().toISOString(),
          settings: settings,
          nodes: nodes,
          autoDraftLogs: autoDraftStatus.logs // NEW: Export logs
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title}_Project_Backup.json`;
      a.click();
  };

  const handleExportNovel = () => {
      const root = nodes.find(n => n.type === NodeType.ROOT);
      if (!root) return;

      let md = `# ${root.title}\n\n【世界观设定】\n${root.content}\n\n`;
      md += `=====================================\n\n`;
      
      const outlines = nodes.filter(n => n.type === NodeType.OUTLINE && n.parentId === root.id);
      outlines.sort((a,b) => a.y - b.y);

      outlines.forEach(outline => {
          md += `## ${outline.title}\n\n`;
          
          const plots = nodes.filter(n => n.type === NodeType.PLOT && n.parentId === outline.id);
          plots.sort((a,b) => a.y - b.y);

          plots.forEach(plot => {
               const chapters = nodes.filter(n => n.type === NodeType.CHAPTER && n.parentId === plot.id);
               chapters.sort((a,b) => a.y - b.y);
               
               chapters.forEach(chap => {
                   md += `### ${chap.title}\n\n`;
                   md += `${chap.content || chap.summary}\n\n`;
                   md += `-------------------------------------\n\n`;
               });
          });
          md += `\n`;
      });

      const blob = new Blob([md], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${root.title}.txt`;
      a.click();
  };

  const handleReset = () => {
      if(confirm("确定要清空所有数据重新开始吗？此操作无法撤销。")) {
          localStorage.clear();
          window.location.reload();
      }
  };

  const getStoryContext = (currentNodeId: string): string => {
      let context = "";
      const current = nodes.find(n => n.id === currentNodeId);
      if (!current || !current.prevNodeId) return "";

      let limit = 5; 
      let ptr = current.prevNodeId;
      const history = [];

      while(ptr && limit > 0) {
          const node = nodes.find(n => n.id === ptr);
          if (node) {
              history.unshift(`[${node.title}]: ${node.summary}`);
              ptr = node.prevNodeId || undefined;
              limit--;
          } else {
              break;
          }
      }
      return history.join('\n');
  };
  
  const handleStartCreation = async (title: string, newSettings: AppSettings) => {
      setGlobalLoading(true);
      setSettings(newSettings);
      
      try {
          const initialWorldview = await generateInitialWorldview(title, newSettings);

          const rootNode: NodeData = {
              id: generateId(),
              type: NodeType.ROOT,
              title: `《${title}》核心设定`,
              summary: initialWorldview, 
              content: initialWorldview, 
              x: 100, y: 300,
              parentId: null,
              childrenIds: [],
              collapsed: false,
              associations: [],
              status: {}
          };
          
          const initialNodes = [rootNode];
          setNodes(initialNodes); // Single node needs no layout
          setIsInitialized(true);
          
          // Pass newSettings explicitly to avoid closure stale state
          triggerWorldAnalysis(initialWorldview, rootNode.id, newSettings);

      } catch (error) {
          alert("初始化失败，请重试。请检查 API Key 和网络配置。");
          console.error(error);
      } finally {
          setGlobalLoading(false);
      }
  };

  // Fix: Accepts settings override for initial Welcome Screen usage
  const handleOptimizePrompt = async (title: string, style: string, current: string, settingsOverride: AppSettings) => {
      setGlobalLoading(true);
      try {
          return await optimizeSystemInstruction(title, style, current, settingsOverride);
      } finally {
          setGlobalLoading(false);
      }
  };

  const handleNodeSelect = (id: string) => {
    setSelectedNodeId(id);
  };

  const handleNodeMove = (id: string, x: number, y: number) => {
    setNodes(prev => prev.map(n => n.id === id ? { ...n, x, y } : n));
  };

  const handleNodeUpdate = (id: string, updates: Partial<NodeData>) => {
    setNodes(prev => {
        // 1. Update the target node
        let nextNodes = prev.map(n => n.id === id ? { ...n, ...updates } : n);
        
        // 2. Resource Bubble-up: If associations updated, propagate to Parent
        if (updates.associations) {
            const childNode = nextNodes.find(n => n.id === id);
            if (childNode && childNode.parentId) {
                // Find parent and merge associations
                nextNodes = nextNodes.map(n => {
                    if (n.id === childNode.parentId) {
                         // Union of parent associations + child associations
                         const merged = Array.from(new Set([...(n.associations || []), ...(updates.associations || [])]));
                         return { ...n, associations: merged };
                    }
                    return n;
                });
            }
        }
        return nextNodes;
    });

    // Background Analysis trigger
    if (updates.content && updates.content.length > (nodes.find(n=>n.id===id)?.content.length || 0) + 50) {
         triggerWorldAnalysis(updates.content, id);
    }
  };

  const handleToggleCollapse = (id: string) => {
      setNodes(prev => {
          const updated = prev.map(n => n.id === id ? { ...n, collapsed: !n.collapsed } : n);
          return updateLayout(updated); // Re-layout on collapse
      });
  };

  const handleSyncLoreUpdates = (updates: LoreUpdateSuggestion[]) => {
      setNodes(prev => {
          let newNodes = [...prev];
          updates.forEach(u => {
              newNodes = newNodes.map(n => {
                  if (n.id === u.targetId) {
                      return { ...n, summary: u.newSummary };
                  }
                  return n;
              });
          });
          return newNodes;
      });
      alert(`已更新 ${updates.length} 个设定的描述信息。`);
  };

  const handleNodeDelete = (id: string) => {
    setNodes(prev => {
      const nodeToDelete = prev.find(n => n.id === id);
      const prevNodeId = nodeToDelete?.prevNodeId;
      const nextNode = prev.find(n => n.prevNodeId === id);
      const remaining = prev.filter(n => n.id !== id);
      
      const cleaned = remaining.map(n => {
        let newNode = { ...n };
        if (newNode.childrenIds.includes(id)) {
            newNode.childrenIds = newNode.childrenIds.filter(cid => cid !== id);
        }
        if (n.id === nextNode?.id && prevNodeId) {
            newNode.prevNodeId = prevNodeId;
        } else if (n.id === nextNode?.id) {
            newNode.prevNodeId = null;
        }
        if (newNode.associations?.includes(id)) {
            newNode.associations = newNode.associations.filter(aid => aid !== id);
        }
        return newNode;
      });
      return updateLayout(cleaned);
    });
    if (selectedNodeId === id) setSelectedNodeId(null);
  };

  const handleAddChildren = (parentId: string, newNodesData: Partial<NodeData>[]) => {
     const parent = nodes.find(n => n.id === parentId);
     if (!parent) return;

     let previousSiblingId: string | null = null;
     if (parent.childrenIds.length > 0) {
         previousSiblingId = parent.childrenIds[parent.childrenIds.length - 1];
     }

     const newNodes: NodeData[] = newNodesData.map((data, index) => {
         const newId = generateId();
         return {
             id: newId,
             type: data.type || NodeType.PLOT,
             title: data.title || 'New Node',
             summary: data.summary || '',
             content: data.summary || '', 
             x: 0, // Auto Layout will set this
             y: 0, // Auto Layout will set this
             parentId: parentId,
             childrenIds: [],
             prevNodeId: index === 0 ? previousSiblingId : null,
             associations: parent.associations ? [...parent.associations] : [], 
             collapsed: false,
             status: {}
         };
     });

     for (let i = 1; i < newNodes.length; i++) {
         newNodes[i].prevNodeId = newNodes[i-1].id;
     }

     setNodes(prev => {
         const updatedParent = { 
             ...parent, 
             childrenIds: [...parent.childrenIds, ...newNodes.map(n => n.id)],
             collapsed: false 
         };
         const merged = prev.map(n => n.id === parentId ? updatedParent : n).concat(newNodes);
         return updateLayout(merged);
     });

     const combinedText = newNodes.map(n => `${n.title}: ${n.summary}`).join('\n\n');
     triggerWorldAnalysis(combinedText, parentId);
  };

  const handleAddSibling = (prevNodeId: string, newNodeData: Partial<NodeData>) => {
      const prevNode = nodes.find(n => n.id === prevNodeId);
      if (!prevNode) return;
      const nextNode = nodes.find(n => n.prevNodeId === prevNodeId);
      const newNodeId = generateId();
      
      const newNode: NodeData = {
          id: newNodeId,
          type: newNodeData.type || prevNode.type,
          title: newNodeData.title || 'Next Node',
          summary: newNodeData.summary || '',
          content: newNodeData.summary || '',
          x: 0, 
          y: 0,
          parentId: prevNode.parentId,
          childrenIds: [],
          prevNodeId: prevNodeId,
          associations: prevNode.associations ? [...prevNode.associations] : [],
          collapsed: false,
          status: {}
      };

      setNodes(prev => {
          let updatedNodes = [...prev];
          if (newNode.parentId) {
              updatedNodes = updatedNodes.map(n => {
                  if (n.id === newNode.parentId) {
                      return { ...n, childrenIds: [...n.childrenIds, newNodeId] };
                  }
                  return n;
              });
          }
          if (nextNode) {
              updatedNodes = updatedNodes.map(n => {
                  if (n.id === nextNode.id) {
                      return { ...n, prevNodeId: newNodeId };
                  }
                  return n;
              });
          }
          const merged = [...updatedNodes, newNode];
          return updateLayout(merged);
      });

      triggerWorldAnalysis(newNode.summary, newNodeId);
  };

  // Add Resource: Intelligent placement based on type column
  const handleAddResource = (type: NodeType) => {
      const count = nodes.filter(n => n.type === type).length;
      let startX = 0;
      if (type === NodeType.CHARACTER) startX = 0;
      if (type === NodeType.LOCATION) startX = 300;
      if (type === NodeType.FACTION) startX = 600;
      if (type === NodeType.ITEM) startX = 900;

      const newNode: NodeData = {
          id: generateId(),
          type,
          title: `新建${type === NodeType.CHARACTER ? '角色' : (type === NodeType.LOCATION ? '地点' : (type === NodeType.FACTION ? '势力' : '物品'))}`,
          summary: '',
          content: '',
          x: startX, 
          y: 100 + (count * 250), 
          parentId: null,
          childrenIds: [],
          collapsed: false,
          associations: [],
          status: {}
      };
      setNodes(prev => [...prev, newNode]);
      setSelectedNodeId(newNode.id);
      
      // Auto switch to resource view if adding resource
      setViewMode('resource');
  };

  // --- Auto Draft Agent Handlers ---
  const handleStartAutoDraft = (config: AutoDraftConfig) => {
      const root = nodes.find(n => n.type === NodeType.ROOT);
      if (!root) return;

      setShowAutoDraftModal(false);
      setShowStatusOverlay(true); // NEW: Always show overlay on start
      
      // Reset logs if new session or keep? Let's reset for new run.
      setAutoDraftStatus({ isActive: true, currentStage: 'Agent 初始化...', progress: 0, logs: [] });

      const agent = new AutoDraftAgent(
          settings,
          config,
          (updateFn) => setNodes(prev => updateLayout(updateFn(prev))), // Wrap setNodes with layout
          () => nodesRef.current, // Always access latest state
          (status) => setAutoDraftStatus(prev => ({...prev, ...status}))
      );
      
      autoDraftAgentRef.current = agent;
      agent.start(root.id);
  };

  const handleStopAutoDraft = () => {
      if (autoDraftAgentRef.current) {
          autoDraftAgentRef.current.stop();
          // Rely on agent to update status logic for stop
      }
  };
  
  const handleDownloadLogs = () => {
      const blob = new Blob([autoDraftStatus.logs.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `AutoDraft_Logs_${new Date().toISOString()}.txt`;
      a.click();
  };

  const selectedNode = nodes.find(n => n.id === selectedNodeId) || null;

  if (!isInitialized) {
      return (
          <WelcomeScreen 
             onStart={handleStartCreation} 
             initialSettings={settings}
             onOptimizePrompt={handleOptimizePrompt}
             onImport={handleImportProject}
             isLoading={globalLoading}
          />
      );
  }

  // Helper to determine status icon
  const getStatusIcon = () => {
      if (autoDraftStatus.isActive) return <Loader2 size={18} className="animate-spin text-indigo-400" />;
      if (autoDraftStatus.currentStage === 'Error' || autoDraftStatus.logs.some(l => l.includes('Error') || l.includes('错误'))) return <AlertCircle size={18} className="text-red-400" />;
      return <CheckCircle size={18} className="text-emerald-400" />;
  };

  return (
    <div className="flex h-screen w-screen bg-[#0b0f19] text-white overflow-hidden font-sans relative">
      
      {/* Global Loading Overlay */}
      {globalLoading && (
          <div className="absolute inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center flex-col gap-4">
              <Loader2 size={48} className="animate-spin text-indigo-500" />
              <div className="text-xl font-bold text-white animate-pulse">正在施法中...</div>
          </div>
      )}

      {/* Auto Draft Modal */}
      {showAutoDraftModal && (
          <AutoDraftModal 
              onStart={handleStartAutoDraft} 
              onClose={() => setShowAutoDraftModal(false)}
          />
      )}

      {/* Auto Draft Status Overlay */}
      {showStatusOverlay && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[80] bg-slate-900/90 border border-indigo-500/50 rounded-xl p-4 shadow-2xl backdrop-blur-md min-w-[350px] max-w-[400px] flex flex-col gap-2 animate-in fade-in slide-in-from-top-4">
              <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                      {getStatusIcon()}
                      <span className="font-bold text-sm text-indigo-100">
                          {autoDraftStatus.isActive ? 'Agent 工作中...' : (autoDraftStatus.currentStage === 'Error' ? '任务中断' : '任务完成')}
                      </span>
                  </div>
                  <div className="flex items-center gap-2">
                      <button onClick={handleDownloadLogs} className="text-slate-400 hover:text-white transition" title="下载日志">
                          <Download size={16} />
                      </button>
                      
                      {/* Show Stop if active, Close if not */}
                      {autoDraftStatus.isActive ? (
                          <button onClick={handleStopAutoDraft} className="text-red-400 hover:text-red-300 transition" title="停止">
                              <StopCircle size={18} />
                          </button>
                      ) : (
                          <button onClick={() => setShowStatusOverlay(false)} className="text-slate-400 hover:text-white transition" title="关闭">
                             <X size={18} />
                          </button>
                      )}
                  </div>
              </div>
              <div className="text-xs text-slate-300 font-mono border-t border-slate-700 pt-2 mt-1 truncate" title={autoDraftStatus.currentStage}>
                  {autoDraftStatus.currentStage}
              </div>
              <div className="max-h-[150px] overflow-y-auto text-[10px] text-slate-500 font-mono bg-black/30 p-2 rounded custom-scrollbar">
                  {autoDraftStatus.logs.slice().reverse().map((log, i) => (
                      <div key={i} className="truncate border-b border-white/5 py-0.5 hover:text-slate-300 cursor-default" title={log}>{log}</div>
                  ))}
              </div>
          </div>
      )}

      <Sidebar 
        nodes={nodes}
        settings={settings}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onSettingsChange={setSettings}
        onSelectNode={handleNodeSelect}
        onAddResource={handleAddResource}
        selectedNodeId={selectedNodeId}
        onExportNovel={handleExportNovel}
        onExportProject={handleExportProject}
        onImportProject={handleImportProject}
        onReset={handleReset}
        onOpenAutoDraft={() => setShowAutoDraftModal(true)}
      />
      
      <div className="flex-1 flex relative">
        <Canvas 
          nodes={nodes}
          viewMode={viewMode}
          selectedNodeId={selectedNodeId}
          onNodeSelect={handleNodeSelect}
          onNodeMove={handleNodeMove}
          onToggleCollapse={handleToggleCollapse}
          onUpdateNode={handleNodeUpdate} // NEW: Pass update handler
        />
        
        {/* Background Processing Indicator */}
        {backgroundProcessing && (
            <div className="absolute top-4 right-4 z-50 bg-indigo-900/80 text-indigo-200 px-3 py-1.5 rounded-full text-xs flex items-center gap-2 shadow-lg backdrop-blur border border-indigo-500/30 animate-pulse">
                <Loader2 size={12} className="animate-spin"/> 世界观同步中...
            </div>
        )}
        
        {selectedNode && (
          <EditorPanel 
            node={selectedNode}
            nodes={nodes}
            settings={settings}
            storyContext={getStoryContext(selectedNode.id)} // Pass rolling context
            onUpdate={(id, updates) => {
                handleNodeUpdate(id, updates);
            }}
            onDelete={handleNodeDelete}
            onClose={() => setSelectedNodeId(null)}
            onAddChildren={handleAddChildren}
            onAddSibling={handleAddSibling}
            onSyncLoreUpdates={handleSyncLoreUpdates}
            setGlobalLoading={setGlobalLoading}
          />
        )}
      </div>
    </div>
  );
};

export default App;
