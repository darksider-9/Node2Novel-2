
import React, { useState } from 'react';
import { AutoDraftConfig } from '../types';
import { Bot, Play, X, Sliders, FileText, Activity, LayoutTemplate } from 'lucide-react';

interface AutoDraftModalProps {
    onStart: (config: AutoDraftConfig) => void;
    onClose: () => void;
}

const AutoDraftModal: React.FC<AutoDraftModalProps> = ({ onStart, onClose }) => {
    const [config, setConfig] = useState<AutoDraftConfig>({
        idea: '',
        volumeCount: 3,
        plotPointsPerVolume: 10,
        chaptersPerPlot: 3,
        wordCountPerChapter: 2000,
        minEffectiveLength: 500,
        recoveryLogs: '',
        enablePlotAnalysis: true,
        pacing: 'Normal',
        outlineMode: false // Default to full writing
    });
    
    const [showRecovery, setShowRecovery] = useState(false);

    // Estimate based on inputs (rough estimate if dynamic is on)
    const totalChapters = config.volumeCount * config.plotPointsPerVolume * config.chaptersPerPlot;
    const estWordCount = totalChapters * config.wordCountPerChapter;

    return (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-indigo-500/50 rounded-2xl w-full max-w-lg shadow-2xl animate-in fade-in zoom-in duration-300 max-h-[90vh] overflow-y-auto custom-scrollbar">
                <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-indigo-900/20 rounded-t-2xl sticky top-0 backdrop-blur-md z-10">
                    <div className="flex items-center gap-3">
                        <div className="bg-indigo-500 p-2 rounded-lg text-white">
                            <Bot size={24} />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white">全自动创作 Agent</h2>
                            <p className="text-xs text-indigo-300">中心管理者模式 (Manager Mode)</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="text-slate-500 hover:text-white transition"><X size={20}/></button>
                </div>

                <div className="p-6 space-y-6">
                    <div className="bg-indigo-950/30 p-4 rounded-xl border border-indigo-500/20 text-xs text-indigo-200 leading-relaxed">
                        <strong className="block mb-2 text-indigo-400">🔥 模式说明：</strong>
                        该模式将接管控制权，根据世界观自动执行：
                        生成 → 逻辑自检 → 指令优化 → 内容润色 → 下钻生成。
                        <br/>适合项目初期快速搭建骨架和填充正文，也支持中途接管。
                    </div>

                    {/* Plot Analysis Agent Section */}
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 space-y-3">
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-bold uppercase text-emerald-400 flex items-center gap-2">
                                <Activity size={14}/> 智能情节设计 Agent
                            </label>
                            <input 
                                type="checkbox" 
                                checked={config.enablePlotAnalysis} 
                                onChange={e => setConfig({...config, enablePlotAnalysis: e.target.checked})}
                                className="w-4 h-4 rounded border-slate-600 text-indigo-600 focus:ring-indigo-500 bg-slate-700"
                            />
                        </div>
                        
                        {config.enablePlotAnalysis && (
                            <div className="animate-in slide-in-from-top-2 space-y-3 pt-2">
                                <p className="text-[10px] text-slate-400">
                                    开启后，AI 将根据内容自动决定生成数量，并分析节奏插入过渡剧情。上方设置的数字将作为参考基准。
                                </p>
                                <div>
                                    <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">叙事节奏 (Pacing)</label>
                                    <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-700">
                                        {(['Fast', 'Normal', 'Slow'] as const).map((p) => (
                                            <button
                                                key={p}
                                                onClick={() => setConfig({...config, pacing: p})}
                                                className={`flex-1 text-xs py-1.5 rounded-md transition ${config.pacing === p ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
                                            >
                                                {p === 'Fast' ? '快节奏 (爽文)' : p === 'Normal' ? '标准' : '慢节奏 (铺垫)'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                    
                    {/* NEW: Outline Mode Toggle */}
                    <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700 flex items-center justify-between">
                         <div className="flex flex-col gap-1">
                            <label className="text-xs font-bold uppercase text-amber-400 flex items-center gap-2">
                                <LayoutTemplate size={14}/> 大纲模式 (Outline Only)
                            </label>
                            <span className="text-[10px] text-slate-400">仅生成到章节细纲，不撰写正文。适合快速验证故事结构。</span>
                         </div>
                         <input 
                            type="checkbox" 
                            checked={config.outlineMode} 
                            onChange={e => setConfig({...config, outlineMode: e.target.checked})}
                            className="w-4 h-4 rounded border-slate-600 text-amber-600 focus:ring-amber-500 bg-slate-700"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase text-slate-500 mb-2">核心创意/融入元素</label>
                        <textarea 
                            value={config.idea}
                            onChange={e => setConfig({...config, idea: e.target.value})}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-white focus:border-indigo-500 focus:outline-none h-20 resize-none"
                            placeholder="例如：赛博朋克风格的剑修，加入克苏鲁元素，主角前期很苟，后期杀伐果断..."
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">预计分卷数</label>
                            <input type="number" min="1" max="10" value={config.volumeCount} onChange={e => setConfig({...config, volumeCount: Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white"/>
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">基准剧情点/卷</label>
                            <input type="number" min="3" max="20" value={config.plotPointsPerVolume} onChange={e => setConfig({...config, plotPointsPerVolume: Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white"/>
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">基准章节数/点</label>
                            <input type="number" min="1" max="10" value={config.chaptersPerPlot} onChange={e => setConfig({...config, chaptersPerPlot: Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white"/>
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">有效内容阈值 (字)</label>
                            <input type="number" step="100" value={config.minEffectiveLength} onChange={e => setConfig({...config, minEffectiveLength: Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-indigo-300 border-indigo-500/30"/>
                        </div>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs text-slate-400 font-mono bg-black/20 p-2 rounded">
                        <span>估算总量: ~{totalChapters} 章</span>
                        <span>{config.outlineMode ? '(不生成正文)' : (config.enablePlotAnalysis ? '(动态调整)' : '')}</span>
                    </div>
                    
                    {/* Recovery Section */}
                    <div className="border-t border-slate-800 pt-4">
                        <button 
                            onClick={() => setShowRecovery(!showRecovery)} 
                            className="flex items-center gap-2 text-xs text-slate-500 hover:text-white transition w-full"
                        >
                            <FileText size={14}/> {showRecovery ? '隐藏故障恢复' : '故障恢复 / 日志续点'}
                        </button>
                        
                        {showRecovery && (
                            <div className="mt-3 animate-in slide-in-from-top-2">
                                <label className="block text-[10px] text-slate-500 mb-1">粘贴之前的运行日志 (Logs) 以跳过已完成的步骤：</label>
                                <textarea 
                                    value={config.recoveryLogs}
                                    onChange={e => setConfig({...config, recoveryLogs: e.target.value})}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-[10px] text-slate-400 font-mono focus:border-indigo-500 focus:outline-none h-24 resize-none leading-tight"
                                    placeholder="[12:00:00] [智能审计] 节点 XXX 质量达标 (PASS)..."
                                />
                            </div>
                        )}
                    </div>

                    <button 
                        onClick={() => onStart(config)}
                        className="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2 transition"
                    >
                        <Play size={18} fill="currentColor" /> {config.recoveryLogs ? '恢复进度并启动' : (config.outlineMode ? '启动大纲生成器' : '启动自动化引擎')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AutoDraftModal;