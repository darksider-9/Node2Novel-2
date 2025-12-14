
import React, { useState } from 'react';
import { AutoDraftConfig } from '../types';
import { Bot, Play, X, Sliders } from 'lucide-react';

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
        wordCountPerChapter: 2000
    });

    const totalChapters = config.volumeCount * config.plotPointsPerVolume * config.chaptersPerPlot;
    const estWordCount = totalChapters * config.wordCountPerChapter;

    return (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-indigo-500/50 rounded-2xl w-full max-w-lg shadow-2xl animate-in fade-in zoom-in duration-300">
                <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-indigo-900/20 rounded-t-2xl">
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
                        <br/>适合项目初期快速搭建骨架和填充正文。
                    </div>

                    <div>
                        <label className="block text-xs font-bold uppercase text-slate-500 mb-2">核心创意/融入元素</label>
                        <textarea 
                            value={config.idea}
                            onChange={e => setConfig({...config, idea: e.target.value})}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-white focus:border-indigo-500 focus:outline-none h-24 resize-none"
                            placeholder="例如：赛博朋克风格的剑修，加入克苏鲁元素，主角前期很苟，后期杀伐果断..."
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">分卷数量</label>
                            <input type="number" min="1" max="10" value={config.volumeCount} onChange={e => setConfig({...config, volumeCount: Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white"/>
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">每卷剧情点数</label>
                            <input type="number" min="3" max="20" value={config.plotPointsPerVolume} onChange={e => setConfig({...config, plotPointsPerVolume: Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white"/>
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">每点章节数</label>
                            <input type="number" min="1" max="10" value={config.chaptersPerPlot} onChange={e => setConfig({...config, chaptersPerPlot: Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white"/>
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">单章字数</label>
                            <input type="number" step="500" value={config.wordCountPerChapter} onChange={e => setConfig({...config, wordCountPerChapter: Number(e.target.value)})} className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white"/>
                        </div>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs text-slate-400 font-mono bg-black/20 p-2 rounded">
                        <span>总章节: {totalChapters}</span>
                        <span>预估总字数: {(estWordCount / 10000).toFixed(1)} 万字</span>
                    </div>

                    <button 
                        onClick={() => onStart(config)}
                        className="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold rounded-xl shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2 transition"
                    >
                        <Play size={18} fill="currentColor" /> 启动自动化引擎
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AutoDraftModal;
    