
import React, { useState, useRef } from 'react';
import { NodeData, NodeType, AppSettings, ViewMode } from '../types';
import { NOVEL_STYLES } from '../constants';
import { Settings, Users, Package, Plus, Feather, ChevronDown, ChevronRight, Download, Trash2, Key, FileJson, FileText, Upload, Save, FileCode, Map as MapIcon, Flag, Layout, Database, Sliders, Globe, Cpu, Thermometer, Bot } from 'lucide-react';

interface SidebarProps {
  nodes: NodeData[];
  settings: AppSettings;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onSettingsChange: (newSettings: AppSettings) => void;
  onSelectNode: (id: string) => void;
  onAddResource: (type: NodeType) => void;
  selectedNodeId: string | null;
  onExportNovel: () => void;
  onExportProject: () => void;
  onImportProject: (file: File) => void;
  onReset: () => void;
  onOpenAutoDraft: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ nodes, settings, viewMode, onViewModeChange, onSettingsChange, onSelectNode, onAddResource, selectedNodeId, onExportNovel, onExportProject, onImportProject, onReset, onOpenAutoDraft }) => {
  const characters = nodes.filter(n => n.type === NodeType.CHARACTER);
  const items = nodes.filter(n => n.type === NodeType.ITEM);
  const locations = nodes.filter(n => n.type === NodeType.LOCATION);
  const factions = nodes.filter(n => n.type === NodeType.FACTION);

  const [showSettings, setShowSettings] = useState(false);
  const [activeResTab, setActiveResTab] = useState<'char' | 'map' | 'item' | 'faction'>('char');

  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Logic to show Auto Draft Button:
  // Now: Show whenever Root exists and we are in Story mode, allowing mid-stream resumption.
  const hasRoot = nodes.some(n => n.type === NodeType.ROOT);
  const showAutoDraft = hasRoot && viewMode === 'story';

  // Helper to find where a resource is used
  const getMentions = (resourceId: string) => {
      return nodes.filter(n => n.associations?.includes(resourceId));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files[0]) {
          onImportProject(e.target.files[0]);
          e.target.value = ''; // Reset input
      }
  };

  const renderResourceList = (list: NodeData[], type: NodeType, icon: React.ReactNode, emptyText: string) => (
      <div className="animate-in fade-in duration-300">
           <div className="px-4 flex items-center justify-between mb-2 mt-2">
                 <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                     {icon} 列表 ({list.length})
                 </h3>
                 <button 
                    onClick={() => onAddResource(type)} 
                    className="text-slate-400 hover:text-white hover:bg-slate-800 p-1 rounded transition"
                    title="手动添加"
                 >
                    <Plus size={14}/>
                 </button>
            </div>
            <ul className="space-y-0.5 px-2">
                  {list.map(node => {
                      const mentions = getMentions(node.id);
                      const isSelected = selectedNodeId === node.id;
                      // Color mapping
                      let activeClass = 'bg-slate-700 text-white';
                      if (type === NodeType.CHARACTER) activeClass = 'bg-pink-900/40 text-pink-200 border-pink-500/30';
                      if (type === NodeType.ITEM) activeClass = 'bg-indigo-900/40 text-indigo-200 border-indigo-500/30';
                      if (type === NodeType.LOCATION) activeClass = 'bg-teal-900/40 text-teal-200 border-teal-500/30';
                      if (type === NodeType.FACTION) activeClass = 'bg-orange-900/40 text-orange-200 border-orange-500/30';

                      return (
                        <li key={node.id} className="relative group">
                            <div 
                                onClick={() => onSelectNode(node.id)} 
                                className={`px-3 py-2.5 rounded-md cursor-pointer text-sm transition border border-transparent ${isSelected ? `border ${activeClass}` : 'hover:bg-slate-900 text-slate-300 hover:text-white'}`}
                            >
                                <div className="flex items-center gap-2 mb-0.5">
                                    <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white shadow-[0_0_5px_white]' : 'bg-slate-600 group-hover:bg-white'}`}></span>
                                    <div className="font-bold text-xs truncate flex-1">{node.title}</div>
                                    {mentions.length > 0 && <span className="text-[9px] bg-black/20 px-1.5 rounded-full text-white/40">{mentions.length}</span>}
                                </div>
                                <div className="text-[10px] text-slate-500 truncate pl-3.5 opacity-70 group-hover:opacity-100">{node.summary || "暂无描述"}</div>
                            </div>
                        </li>
                      );
                  })}
                  {list.length === 0 && <div className="px-4 text-[10px] text-slate-700 italic py-2 text-center">{emptyText}</div>}
              </ul>
      </div>
  );

  return (
    <div className="flex h-full shadow-2xl z-20">
        {/* 1. Navigation Rail (Leftmost) */}
        <div className="w-12 bg-slate-950 border-r border-slate-800 flex flex-col items-center py-4 gap-4">
             <div className="bg-indigo-600 p-2 rounded-lg shadow-lg shadow-indigo-500/30 mb-2">
                 <Feather size={16} className="text-white" />
             </div>
             
             {/* View Toggle */}
             <div className="flex flex-col gap-2 w-full px-2">
                 <button 
                    onClick={() => onViewModeChange('story')}
                    className={`p-2 rounded-lg transition flex justify-center group relative ${viewMode === 'story' ? 'bg-indigo-900/50 text-indigo-300' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900'}`}
                    title="剧情工作台"
                 >
                     <Layout size={18} />
                     <div className="absolute left-10 bg-slate-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50">剧情模式</div>
                 </button>

                 <button 
                    onClick={() => onViewModeChange('resource')}
                    className={`p-2 rounded-lg transition flex justify-center group relative ${viewMode === 'resource' ? 'bg-teal-900/50 text-teal-300' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900'}`}
                    title="世界设定集"
                 >
                     <Database size={18} />
                     <div className="absolute left-10 bg-slate-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50">资源模式</div>
                 </button>
             </div>

             <div className="mt-auto flex flex-col gap-4 mb-2">
                 <button onClick={onSettingsChange.bind(null, settings)} className="p-2 text-slate-500 hover:text-white" title="Settings"><Settings size={18}/></button>
             </div>
        </div>

        {/* 2. Sidebar Content Panel */}
        <div className="w-64 bg-[#0f121a] border-r border-slate-800 flex flex-col h-full font-sans">
            {/* Header */}
            <div className="p-4 border-b border-slate-800 bg-slate-900/50 shrink-0">
                <h1 className="text-white font-bold tracking-tight text-sm">
                    {viewMode === 'story' ? 'Story Board (剧情)' : 'World Bible (设定)'}
                </h1>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5">NovelWeaver Pro</div>
            </div>

            {/* --- STORY MODE SIDEBAR --- */}
            {viewMode === 'story' && (
                <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-800/50 text-xs text-slate-400">
                        <p className="mb-2 font-bold text-slate-300">👋 欢迎回来</p>
                        在此模式下，专注于：
                        <ul className="list-disc list-inside mt-1 space-y-1 opacity-80">
                            <li>架构分卷与大纲</li>
                            <li>推演剧情事件</li>
                            <li>撰写章节正文</li>
                        </ul>
                    </div>
                    
                    {/* Auto Draft Entry */}
                    {showAutoDraft && (
                         <div className="animate-in slide-in-from-left-2">
                             <button 
                                onClick={onOpenAutoDraft}
                                className="w-full bg-gradient-to-r from-indigo-900 to-purple-900 hover:from-indigo-800 hover:to-purple-800 text-white text-xs py-3 rounded-lg flex items-center justify-center gap-2 border border-indigo-500/30 shadow-lg shadow-indigo-900/20 group transition-all"
                             >
                                 <Bot size={16} className="text-indigo-300 group-hover:text-white"/> 
                                 <span className="font-bold">开启全自动创作模式</span>
                             </button>
                             <p className="text-[9px] text-indigo-400/60 mt-1 text-center">中心 Agent 将接管流程，自动生成大纲与正文</p>
                         </div>
                    )}

                    {/* Actions */}
                    <div className="space-y-2">
                        <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">项目操作</h3>
                        
                        <button onClick={onExportNovel} className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs py-2.5 rounded-lg flex items-center gap-2 border border-slate-700 px-3 transition">
                            <FileText size={14} className="text-emerald-500"/> 导出全书 (TXT)
                        </button>

                        <button onClick={onExportProject} className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs py-2.5 rounded-lg flex items-center gap-2 border border-slate-700 px-3 transition">
                            <Save size={14} className="text-blue-500"/> 导出备份 (JSON)
                        </button>

                        <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".json" className="hidden" />
                        <button onClick={() => fileInputRef.current?.click()} className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs py-2.5 rounded-lg flex items-center gap-2 border border-slate-700 px-3 transition">
                            <Upload size={14} className="text-amber-500"/> 恢复存档
                        </button>
                        
                        <div className="border-t border-slate-800 my-4 pt-4"></div>

                        <button onClick={onReset} className="w-full text-red-400/60 hover:text-red-400 hover:bg-red-900/10 text-[10px] py-2 rounded flex items-center justify-center gap-1 transition">
                            <Trash2 size={12}/> 清空所有数据
                        </button>
                    </div>
                </div>
            )}

            {/* --- RESOURCE MODE SIDEBAR --- */}
            {viewMode === 'resource' && (
                <div className="flex-1 flex flex-col min-h-0">
                    <div className="flex border-b border-slate-800 bg-slate-900/30 shrink-0">
                        <button onClick={() => setActiveResTab('char')} className={`flex-1 py-3 flex justify-center border-b-2 transition ${activeResTab==='char' ? 'border-pink-500 text-pink-400 bg-pink-900/10' : 'border-transparent text-slate-500 hover:text-slate-300'}`} title="角色"><Users size={14}/></button>
                        <button onClick={() => setActiveResTab('map')} className={`flex-1 py-3 flex justify-center border-b-2 transition ${activeResTab==='map' ? 'border-teal-500 text-teal-400 bg-teal-900/10' : 'border-transparent text-slate-500 hover:text-slate-300'}`} title="地点"><MapIcon size={14}/></button>
                        <button onClick={() => setActiveResTab('faction')} className={`flex-1 py-3 flex justify-center border-b-2 transition ${activeResTab==='faction' ? 'border-orange-500 text-orange-400 bg-orange-900/10' : 'border-transparent text-slate-500 hover:text-slate-300'}`} title="势力"><Flag size={14}/></button>
                        <button onClick={() => setActiveResTab('item')} className={`flex-1 py-3 flex justify-center border-b-2 transition ${activeResTab==='item' ? 'border-indigo-500 text-indigo-400 bg-indigo-900/10' : 'border-transparent text-slate-500 hover:text-slate-300'}`} title="物品"><Package size={14}/></button>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-950/20">
                         {activeResTab === 'char' && renderResourceList(characters, NodeType.CHARACTER, <Users size={12}/>, "暂无角色...")}
                         {activeResTab === 'map' && renderResourceList(locations, NodeType.LOCATION, <MapIcon size={12}/>, "暂无地点...")}
                         {activeResTab === 'faction' && renderResourceList(factions, NodeType.FACTION, <Flag size={12}/>, "暂无势力...")}
                         {activeResTab === 'item' && renderResourceList(items, NodeType.ITEM, <Package size={12}/>, "暂无物品...")}
                    </div>
                </div>
            )}

            {/* Settings Footer (Always Visible) */}
            <div className="border-t border-slate-800 bg-slate-950 shrink-0">
                <button 
                    onClick={() => setShowSettings(!showSettings)}
                    className={`w-full p-4 flex items-center justify-between transition ${showSettings ? 'text-white bg-slate-900' : 'text-slate-500 hover:text-white'}`}
                >
                    <div className="flex items-center gap-2">
                            <Settings size={14} />
                            <span className="text-xs font-bold uppercase">全局配置</span>
                    </div>
                    {showSettings ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
                </button>
                
                {showSettings && (
                    <div className="px-4 pb-6 space-y-4 animate-in slide-in-from-bottom-2 duration-200 bg-slate-900 border-b border-slate-800 max-h-[50vh] overflow-y-auto custom-scrollbar">
                        
                        {/* 1. API Basic */}
                        <div>
                            <label className="text-[10px] text-slate-500 uppercase block mb-1.5 font-semibold flex items-center gap-1"><Key size={10}/> API Key</label>
                                <input 
                                    type="password" 
                                    value={settings.apiKey}
                                    onChange={(e) => onSettingsChange({...settings, apiKey: e.target.value})}
                                    placeholder="sk-..."
                                    className="w-full bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 p-2 focus:border-blue-500 focus:outline-none placeholder-slate-600 font-mono"
                                />
                        </div>

                         {/* 2. Model Settings */}
                         <div className="bg-black/20 p-2 rounded border border-slate-800 space-y-3">
                             <div>
                                <label className="text-[10px] text-slate-500 uppercase block mb-1.5 font-semibold flex items-center gap-1"><Cpu size={10}/> Model Name</label>
                                <input 
                                    type="text" 
                                    value={settings.modelName}
                                    onChange={(e) => onSettingsChange({...settings, modelName: e.target.value})}
                                    placeholder="gemini-2.5-flash"
                                    className="w-full bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 p-2 focus:border-blue-500 focus:outline-none placeholder-slate-600 font-mono"
                                />
                             </div>

                             <div>
                                <label className="text-[10px] text-slate-500 uppercase block mb-1.5 font-semibold flex items-center gap-1"><Globe size={10}/> Base URL</label>
                                <input 
                                    type="text" 
                                    value={settings.baseUrl}
                                    onChange={(e) => onSettingsChange({...settings, baseUrl: e.target.value})}
                                    placeholder="https://generativelanguage.googleapis.com"
                                    className="w-full bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 p-2 focus:border-blue-500 focus:outline-none placeholder-slate-600 font-mono"
                                />
                             </div>

                             <div>
                                <div className="flex justify-between items-center mb-1">
                                    <label className="text-[10px] text-slate-500 uppercase font-semibold flex items-center gap-1"><Thermometer size={10}/> Temperature</label>
                                    <span className="text-[10px] text-slate-400 font-mono">{settings.temperature}</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="0" max="2" step="0.1"
                                    value={settings.temperature}
                                    onChange={(e) => onSettingsChange({...settings, temperature: parseFloat(e.target.value)})}
                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                                />
                             </div>
                             
                             <div>
                                <label className="text-[10px] text-slate-500 uppercase block mb-1.5 font-semibold flex items-center gap-1">Thinking Budget (Tokens)</label>
                                <input 
                                    type="number"
                                    min="0"
                                    step="1024"
                                    value={settings.thinkingBudget}
                                    onChange={(e) => onSettingsChange({...settings, thinkingBudget: parseInt(e.target.value) || 0})}
                                    className="w-full bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 p-2 focus:border-blue-500 focus:outline-none placeholder-slate-600 font-mono"
                                />
                                <p className="text-[9px] text-slate-600 mt-1">设为 0 以禁用 Thinking。建议 Gemini 2.5 系列开启。</p>
                             </div>
                         </div>
                        
                        {/* 3. System Instruction */}
                        <div>
                            <label className="text-[10px] text-slate-500 uppercase block mb-1.5 font-semibold flex items-center gap-1"><FileCode size={10}/> System Instruction</label>
                            <textarea 
                                value={settings.systemInstruction}
                                onChange={(e) => onSettingsChange({...settings, systemInstruction: e.target.value})}
                                className="w-full h-32 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 p-2 focus:border-blue-500 focus:outline-none placeholder-slate-600 custom-scrollbar resize-y"
                                placeholder="输入系统提示词..."
                            />
                        </div>

                            <div>
                            <label className="text-[10px] text-blue-400 uppercase block mb-1.5 font-semibold">小说流派</label>
                            <select 
                                value={settings.novelStyle}
                                onChange={(e) => onSettingsChange({...settings, novelStyle: e.target.value})}
                                className="w-full bg-slate-800 border border-slate-700 rounded text-xs text-slate-200 p-2 focus:border-blue-500 focus:outline-none"
                            >
                                {NOVEL_STYLES.map(style => (
                                    <option key={style} value={style}>{style}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}
            </div>
        </div>
    </div>
  );
};
