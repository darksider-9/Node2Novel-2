
import React, { useState, useRef } from 'react';
import { AutoDraftConfig, GenerationDepth } from '../types';
import { Bot, Play, X, Sliders, FileText, Activity, LayoutTemplate, Upload, Layers, ListTree, BookOpen, PenTool } from 'lucide-react';

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
        targetDepth: 'PROSE' // Default to full generation
    });
    
    const [showRecovery, setShowRecovery] = useState(false);
    const [fileName, setFileName] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Estimate based on inputs (rough estimate if dynamic is on)
    const totalChapters = config.volumeCount * config.plotPointsPerVolume * config.chaptersPerPlot;

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setFileName(file.name);
            const reader = new FileReader();
            reader.onload = (event) => {
                const text = event.target?.result as string;
                setConfig({ ...config, recoveryLogs: text });
            };
            reader.readAsText(file);
        }
    };

    const depths: { id: GenerationDepth; label: string; icon: React.ReactNode; desc: string }[] = [
        { id: 'OUTLINE', label: '1. 分卷规划', icon: <Layers size={14}/>, desc: '仅生成大副本/分卷结构' },
        { id: 'PLOT', label: '2. 剧情推演', icon: <ListTree size={14}/>, desc: '生成具体事件流 (Plot)' },
        { id: 'CHAPTER', label: '3. 章节细纲', icon: <BookOpen size={14}/>, desc: '生成章节标题与摘要' },
        { id: 'PROSE', label: '4. 全书正文', icon: <PenTool size={14}/>, desc: '撰写完整小说内容' },
    ];

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

                    {/* Target Depth Selection */}
                    <div className="space-y-2">
                        <label className="text-xs font-bold uppercase text-slate-500 flex items-center gap-2">
                            <LayoutTemplate size={14}/> 生成深度 (Target Depth)
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {depths.map(d => (
                                <button
                                    key={d.id}
                                    onClick={() => setConfig({...config, targetDepth: d.id})}
                                    className={`p-3 rounded-lg border text-left transition relative overflow-hidden ${config.targetDepth === d.id ? 'bg-indigo-900/40 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-750'}`}
                                >
                                    <div className="flex items-center gap-2 mb-1 text-xs font-bold">
                                        {d.icon} {d.label}
                                    </div>
                                    <div className="text-[9px] opacity-70">{d.desc}</div>
                                    {config.targetDepth === d.id && (
                                        <div className="absolute top-0 right-0 w-3 h-3 bg-indigo-500 rounded-bl-lg"></div>
                                    )}
                                </button>
                            ))}
                        </div>
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
                        <span>{config.targetDepth !== 'PROSE' ? '(不生成正文)' : (config.enablePlotAnalysis ? '(动态调整)' : '')}</span>
                    </div>
                    
                    {/* Recovery Section */}
                    <div className="border-t border-slate-800 pt-4">
                        <button 
                            onClick={() => setShowRecovery(!showRecovery)} 
                            className="flex items-center gap-2 text-xs text-slate-500 hover:text-white transition w-full"
                        >
                            <FileText size={14}/> {showRecovery ? '隐藏恢复选项' : '上传之前的日志续点 (.txt)'}
                        </button>
                        
                        {showRecovery && (
                            <div className="mt-3 p-4 bg-slate-950/50 border border-dashed border-slate-700 rounded-xl text-center animate-in slide-in-from-top-2">
                                <input 
                                    type="file" 
                                    ref={fileInputRef} 
                                    onChange={handleFileUpload} 
                                    accept=".txt" 
                                    className="hidden" 
                                />
                                <button 
                                    onClick={() => fileInputRef.current?.click()} 
                                    className="flex flex-col items-center gap-2 w-full hover:opacity-80 transition"
                                >
                                    <Upload className="text-indigo-400" size={24}/>
                                    <span className="text-xs text-slate-400">{fileName || "点击上传日志文件"}</span>
                                </button>
                                {config.recoveryLogs && (
                                    <div className="mt-2 text-[10px] text-emerald-400 font-mono truncate max-w-full">
                                        日志已加载 (长度: {config.recoveryLogs.length})
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <button 
                        onClick={() => onStart(config)}
                        className="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2 transition"
                    >
                        <Play size={18} fill="currentColor" /> {config.recoveryLogs ? '恢复进度并启动' : '启动自动化引擎'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AutoDraftModal;
