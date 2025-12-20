
import React, { useRef, useState, useMemo } from 'react';
import { NodeData, NodeType, ViewMode } from '../types';
import { NODE_COLORS, NODE_STATUS_CONFIG } from '../constants';
import { ZoomIn, ZoomOut, ChevronRight, FileText, BookOpen, Layers, Move, ChevronDown, Link as LinkIcon, Users, Map, Flag, Package, LocateFixed, CheckCircle } from 'lucide-react';

interface CanvasProps {
  nodes: NodeData[];
  onNodeSelect: (id: string) => void;
  onNodeMove: (id: string, x: number, y: number) => void;
  onToggleCollapse: (id: string) => void;
  onUpdateNode: (id: string, updates: Partial<NodeData>) => void; // NEW: Needed for toggling status
  selectedNodeId: string | null;
  viewMode: ViewMode;
}

const getNodeIcon = (type: NodeType) => {
  switch (type) {
    case NodeType.ROOT: return <BookOpen size={16} />;
    case NodeType.OUTLINE: return <Layers size={16} />;
    case NodeType.PLOT: return <Move size={16} />;
    case NodeType.CHAPTER: return <FileText size={16} />;
    case NodeType.CHARACTER: return <Users size={16} />;
    case NodeType.LOCATION: return <Map size={16} />;
    case NodeType.FACTION: return <Flag size={16} />;
    case NodeType.ITEM: return <Package size={16} />;
    default: return <FileText size={16} />;
  }
};

const Canvas: React.FC<CanvasProps> = ({ nodes, onNodeSelect, onNodeMove, onToggleCollapse, onUpdateNode, selectedNodeId, viewMode }) => {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  const [isDraggingNode, setIsDraggingNode] = useState<string | null>(null);
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const NODE_WIDTH = 224; // w-56 is 14rem = 224px

  // 1. Filter nodes based on ViewMode
  const isNodeVisible = (node: NodeData, allNodes: NodeData[]): boolean => {
      // Resource Mode
      if (viewMode === 'resource') {
          return [NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(node.type);
      }
      
      // Story Mode
      if ([NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(node.type)) {
          return false;
      }
      // Hierarchy check for story nodes
      if (!node.parentId) return true;
      const parent = allNodes.find(n => n.id === node.parentId);
      if (!parent) return true; // Orphaned nodes visible
      if (parent.collapsed) return false;
      return isNodeVisible(parent, allNodes);
  };

  const visibleNodes = useMemo(() => {
      return nodes.filter(n => isNodeVisible(n, nodes));
  }, [nodes, viewMode]);

  const handleCenterRoot = () => {
    const rootNode = nodes.find(n => n.type === NodeType.ROOT) || nodes[0];
    if (rootNode && containerRef.current) {
      const { clientWidth, clientHeight } = containerRef.current;
      const targetScale = 1;
      
      // Calculate center for node (224px width)
      // We assume node height is roughly ~160px based on layout logic
      const nodeCenterX = rootNode.x + (NODE_WIDTH / 2); 
      const nodeCenterY = rootNode.y + 80; 
      
      // offset = ScreenCenter - (NodePos * Scale)
      const newX = (clientWidth / 2) - (nodeCenterX * targetScale);
      const newY = (clientHeight / 2) - (nodeCenterY * targetScale);
      
      setOffset({ x: newX, y: newY });
      setScale(targetScale);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomSensitivity = 0.001;
    const newScale = Math.min(Math.max(0.1, scale - e.deltaY * zoomSensitivity), 3);
    setScale(newScale);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) { 
       setIsDraggingCanvas(true);
       setLastMousePos({ x: e.clientX, y: e.clientY });
       return;
    }
  };

  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    setIsDraggingNode(nodeId);
    setLastMousePos({ x: e.clientX, y: e.clientY });
    onNodeSelect(nodeId);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const dx = e.clientX - lastMousePos.x;
    const dy = e.clientY - lastMousePos.y;

    if (isDraggingCanvas) {
      setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      setLastMousePos({ x: e.clientX, y: e.clientY });
    } else if (isDraggingNode) {
      const node = nodes.find(n => n.id === isDraggingNode);
      if (node) {
        onNodeMove(isDraggingNode, node.x + dx / scale, node.y + dy / scale);
        setLastMousePos({ x: e.clientX, y: e.clientY });
      }
    }
  };

  const handleMouseUp = () => {
    setIsDraggingCanvas(false);
    setIsDraggingNode(null);
  };

  const toggleStatus = (e: React.MouseEvent, nodeId: string, statusKey: string) => {
      e.stopPropagation(); // Prevent drag/select
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      
      const currentStatus = node.status || {};
      onUpdateNode(nodeId, {
          status: { ...currentStatus, [statusKey]: !currentStatus[statusKey] }
      });
  };

  const renderConnections = () => {
    // Only render tree connections in Story Mode
    if (viewMode === 'resource') return null;

    const lines = [];
    
    // Parent -> Child (Tree Structure) - Solid Lines
    visibleNodes.forEach(node => {
        if (node.parentId) {
            const parent = visibleNodes.find(n => n.id === node.parentId);
            if (parent) {
                 const startX = parent.x + NODE_WIDTH;
                 const startY = parent.y + 20;
                 const endX = node.x;
                 const endY = node.y + 20;
                 
                 const cp1x = startX + 50;
                 const cp1y = startY;
                 const cp2x = endX - 50;
                 const cp2y = endY;

                 lines.push(
                    <path
                        key={`parent-${parent.id}-${node.id}`}
                        d={`M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`}
                        stroke="#475569"
                        strokeWidth={2 * scale}
                        fill="none"
                        className="transition-all duration-300"
                    />
                 );
            }
        }
    });

    // Prev -> Next (Narrative Flow) - Dashed Lines
    visibleNodes.forEach(node => {
        if (node.prevNodeId) {
            const prev = visibleNodes.find(n => n.id === node.prevNodeId);
            if (prev) {
                 const startX = prev.x + (NODE_WIDTH / 2);
                 const startY = prev.y + 120; // Approximate bottom of card
                 const endX = node.x + (NODE_WIDTH / 2);
                 const endY = node.y;

                 lines.push(
                    <g key={`chain-${prev.id}-${node.id}`}>
                        <path
                            d={`M ${startX} ${startY} C ${startX} ${startY + 50}, ${endX} ${endY - 50}, ${endX} ${endY}`}
                            stroke={selectedNodeId === node.id ? "#60a5fa" : "#334155"}
                            strokeWidth={1.5 * scale}
                            strokeDasharray="6,4"
                            markerEnd="url(#arrowhead)"
                            fill="none"
                            className="opacity-70"
                        />
                         {selectedNodeId === node.id && (
                             <circle r={3 * scale} fill="#60a5fa">
                               <animateMotion 
                                 dur="1.5s" 
                                 repeatCount="indefinite"
                                 path={`M ${startX} ${startY} C ${startX} ${startY + 50}, ${endX} ${endY - 50}, ${endX} ${endY}`}
                               />
                             </circle>
                         )}
                    </g>
                 );
            }
        }
    });

    return lines;
  };

  return (
    <div 
      ref={containerRef}
      className="flex-1 h-full bg-[#0b0f19] relative overflow-hidden cursor-crosshair select-none"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
        <div 
            className="absolute inset-0 opacity-10 pointer-events-none"
            style={{
                backgroundImage: 'radial-gradient(#64748b 1px, transparent 1px)',
                backgroundSize: `${20 * scale}px ${20 * scale}px`,
                backgroundPosition: `${offset.x}px ${offset.y}px`
            }}
        />

        {/* Legend */}
        <div className="absolute top-4 left-4 z-10 bg-slate-900/90 p-4 rounded-xl border border-slate-700 text-xs text-slate-400 backdrop-blur-md pointer-events-none shadow-2xl">
            <div className="font-bold text-slate-200 mb-2 border-b border-slate-700 pb-1">
                {viewMode === 'story' ? '剧情视图 (Story)' : '资源视图 (Database)'}
            </div>
            <ul className="space-y-1.5">
                <li className="flex items-center gap-2"><span className="bg-slate-700 px-1 rounded text-[10px]">Shift</span> + 拖动：平移画布</li>
                <li className="flex items-center gap-2"><span className="bg-slate-700 px-1 rounded text-[10px]">Scroll</span>：缩放</li>
            </ul>
        </div>

      <div 
        className="absolute transform-gpu origin-top-left"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
      >
        <svg className="absolute top-0 left-0 overflow-visible pointer-events-none" style={{ width: 1, height: 1 }}>
            <defs>
                <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#475569" />
                </marker>
            </defs>
            {renderConnections()}
        </svg>

        {visibleNodes.map(node => {
           const colors = NODE_COLORS[node.type] || NODE_COLORS[NodeType.PLOT];
           const isSelected = selectedNodeId === node.id;
           const hasChildren = (node.childrenIds || []).length > 0;
           const contentExists = node.content && node.content.length > 0;
           
           // Status Configuration
           const statusConfig = NODE_STATUS_CONFIG[node.type] || [];

           return (
            <div
              key={node.id}
              onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
              className={`absolute w-56 p-0 rounded-xl border shadow-2xl transition-all duration-200 cursor-pointer flex flex-col group
                ${colors.bg} ${colors.border} 
                ${isSelected ? 'ring-2 ring-blue-400 shadow-blue-900/50 scale-105 z-50' : 'opacity-90 hover:opacity-100 z-10 hover:shadow-xl hover:shadow-black/40'}
              `}
              style={{ 
                left: node.x, 
                top: node.y,
              }}
            >
              <div className="p-3 border-b border-white/10 flex items-center justify-between bg-black/10 rounded-t-xl h-10">
                 <div className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider ${colors.text}`}>
                    {getNodeIcon(node.type)}
                    {colors.label}
                 </div>
                 {/* Collapse Toggle (Only for Story Nodes) */}
                 {viewMode === 'story' && hasChildren && (
                     <button 
                        onMouseDown={(e) => { e.stopPropagation(); onToggleCollapse(node.id); }}
                        className="hover:bg-white/20 p-0.5 rounded transition"
                     >
                         {node.collapsed ? <ChevronRight size={14} className="text-white"/> : <ChevronDown size={14} className="text-white"/>}
                     </button>
                 )}
              </div>
              <div className="p-3">
                  <div className="font-bold text-white text-sm truncate mb-1" title={node.title}>{node.title}</div>
                  <div className="text-white/60 text-xs line-clamp-3 leading-relaxed font-sans min-h-[3rem]">
                      {node.summary || "暂无描述..."}
                  </div>
              </div>
              
              <div className="flex flex-col gap-2 border-t border-white/5 bg-black/20 rounded-b-xl">
                  {/* Icons Row */}
                  <div className="flex gap-2 px-3 py-2 items-center">
                     {node.prevNodeId && viewMode === 'story' && (
                        <span title="Link to Previous">
                           <LinkIcon size={12} className="text-white/40" />
                        </span>
                     )}
                     {contentExists && (
                        <span title="Has Content">
                           <FileText size={12} className="text-emerald-400" />
                        </span>
                     )}
                     {node.associations && node.associations.length > 0 && (
                         <div className="flex items-center gap-1 text-[9px] text-pink-300 bg-pink-900/40 px-1 rounded">
                             <span className="w-1.5 h-1.5 rounded-full bg-pink-500"></span>
                             {node.associations.length}
                         </div>
                     )}
                  </div>
                  
                  {/* Status Bar */}
                  {statusConfig.length > 0 && (
                      <div className="px-3 pb-2 flex justify-between gap-1">
                          {statusConfig.map(s => {
                              const isActive = node.status?.[s.key];
                              return (
                                  <button
                                    key={s.key}
                                    onMouseDown={(e) => toggleStatus(e, node.id, s.key)}
                                    title={s.label + (isActive ? ' (Completed)' : ' (Pending)')}
                                    className={`flex-1 flex justify-center py-1 rounded transition ${isActive ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800/50 text-slate-600 hover:text-slate-400'}`}
                                  >
                                      <s.icon size={10} />
                                  </button>
                              )
                          })}
                      </div>
                  )}
              </div>
            </div>
          );
        })}
      </div>
      
      <div className="absolute bottom-8 left-8 flex gap-2">
         <button onClick={handleCenterRoot} className="p-2.5 bg-indigo-600 hover:bg-indigo-500 border border-indigo-500 rounded-lg text-white shadow-xl transition" title="回到根节点"><LocateFixed size={18}/></button>
         <button onClick={() => setScale(s => Math.min(s + 0.1, 3))} className="p-2.5 bg-slate-800 border border-slate-700 hover:bg-slate-700 rounded-lg text-white shadow-xl transition"><ZoomIn size={18}/></button>
         <button onClick={() => setScale(s => Math.max(s - 0.1, 0.1))} className="p-2.5 bg-slate-800 border border-slate-700 hover:bg-slate-700 rounded-lg text-white shadow-xl transition"><ZoomOut size={18}/></button>
         <div className="px-3 bg-slate-800 border border-slate-700 text-slate-300 rounded-lg text-xs flex items-center min-w-[60px] justify-center shadow-xl font-mono">{Math.round(scale * 100)}%</div>
      </div>
    </div>
  );
};

export default Canvas;
