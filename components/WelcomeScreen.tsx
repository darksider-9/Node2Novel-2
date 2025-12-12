
import React, { useState, useRef } from 'react';
import { AppSettings } from '../types';
import { NOVEL_STYLES } from '../constants';
import { BookOpen, Sparkles, ChevronRight, Wand2, Key, Settings, Upload, FileJson, ChevronDown, ChevronUp } from 'lucide-react';

interface WelcomeScreenProps {
    onStart: (title: string, settings: AppSettings) => void | Promise<void>;
    onOptimizePrompt: (title: string, style: string, current: string) => Promise<string>;
    onImport: (file: File) => void;
    initialSettings: AppSettings;
    isLoading: boolean;
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onStart, onOptimizePrompt, onImport, initialSettings, isLoading }) => {
    const [title, setTitle] = useState('');
    const [settings, setSettings] = useState<AppSettings>(initialSettings);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [showSystemInstruction, setShowSystemInstruction] = useState(false); // Collapsed by default
    const fileInputRef = useRef<HTMLInputElement>(null);
    
    const handleOptimize = async () => {
        if (!title) {
            alert("请先输入书名");
            return;
        }
        if (!settings.apiKey && !process.env.API_KEY) {
            alert("请先输入 API Key");
            return;
        }
        const newInstruction = await onOptimizePrompt(title, settings.novelStyle, settings.systemInstruction);
        setSettings(prev => ({ ...prev, systemInstruction: newInstruction }));
        setShowSystemInstruction(true); // Auto expand on optimize
    };

    const handleStart = async () => {
        if (!title) {
             alert("书名不能为空");
             return;
        }
        if (!settings.apiKey && !process.env.API_KEY) {
             alert("请先输入 API Key");
             return;
        }
        await onStart(title, settings);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            onImport(e.target.files[0]);
            e.target.value = '';
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-[#0b0f19] text-white p-4 relative overflow-hidden font-sans">
             {/* Background Effects */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
                <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-900/20 rounded-full blur-3xl"></div>
                <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-900/20 rounded-full blur-3xl"></div>
            </div>

            <div className="z-10 max-w-2xl w-full bg-slate-900/80 backdrop-blur-xl border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-8 max-h-[90vh] overflow-y-auto custom-scrollbar">
                <div className="text-center space-y-2">
                    <div className="inline-flex items-center justify-center p-3 bg-gradient-to-br from-indigo-600 to-purple-600 rounded-xl shadow-lg mb-4">
                        <BookOpen size={32} className="text-white" />
                    </div>
                    <h1 className="text-3xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
                        NovelWeaver AI
                    </h1>
                    <p className="text-slate-400">可视化网文创作工作台</p>
                </div>

                <div className="space-y-6">
                    {/* API Configuration Section */}
                    <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800 space-y-4">
                        <div>
                            <label className="block text-xs font-bold uppercase text-slate-500 mb-2 flex items-center gap-2">
                                <Key size={12}/> Gemini API Key <span className="text-red-500">*</span>
                            </label>
                            <input 
                                type="password" 
                                value={settings.apiKey}
                                onChange={(e) => setSettings({...settings, apiKey: e.target.value})}
                                placeholder="sk-..."
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none transition font-mono"
                            />
                        </div>

                        <button 
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            className="text-xs text-slate-500 hover:text-indigo-400 flex items-center gap-1 transition"
                        >
                            <Settings size={12}/> {showAdvanced ? '隐藏高级配置' : '显示高级配置 (BaseURL / Model)'}
                        </button>

                        {showAdvanced && (
                            <div className="grid grid-cols-2 gap-4 animate-in slide-in-from-top-2">
                                <div>
                                    <label className="block text-xs font-bold uppercase text-slate-500 mb-2">Base URL</label>
                                    <input 
                                        type="text" 
                                        value={settings.baseUrl}
                                        onChange={(e) => setSettings({...settings, baseUrl: e.target.value})}
                                        placeholder="https://generativelanguage.googleapis.com"
                                        className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none font-mono"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase text-slate-500 mb-2">Model Name</label>
                                    <input 
                                        type="text" 
                                        value={settings.modelName}
                                        onChange={(e) => setSettings({...settings, modelName: e.target.value})}
                                        placeholder="gemini-2.5-flash"
                                        className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none font-mono"
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-slate-800"></div>
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-slate-900 px-2 text-slate-500">创建新书</span>
                        </div>
                    </div>

                    {/* Title Input */}
                    <div>
                        <label className="block text-xs font-bold uppercase text-slate-500 mb-2">书名 (Novel Title)</label>
                        <input 
                            type="text" 
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="例如：赛博修仙传"
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-lg text-white placeholder-slate-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none transition"
                        />
                    </div>

                    {/* Style Selection */}
                    <div>
                        <label className="block text-xs font-bold uppercase text-slate-500 mb-2">流派/风格 (Genre)</label>
                        <select 
                            value={settings.novelStyle}
                            onChange={(e) => setSettings({...settings, novelStyle: e.target.value})}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-white focus:border-indigo-500 focus:outline-none"
                        >
                            {NOVEL_STYLES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </div>

                    {/* System Prompt Customization */}
                    <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/30">
                        <div 
                            className="flex items-center justify-between p-3 bg-slate-900/50 cursor-pointer hover:bg-slate-900 transition"
                            onClick={() => setShowSystemInstruction(!showSystemInstruction)}
                        >
                            <label className="text-xs font-bold uppercase text-slate-500 flex items-center gap-2 cursor-pointer">
                                {showSystemInstruction ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
                                System Instruction (AI 设定)
                            </label>
                            <button 
                                onClick={(e) => { e.stopPropagation(); handleOptimize(); }}
                                disabled={isLoading || !title}
                                className="text-xs flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 disabled:opacity-50 transition bg-indigo-900/20 px-2 py-1 rounded"
                            >
                                <Sparkles size={12} />
                                {isLoading ? '生成中...' : 'AI 优化提示词'}
                            </button>
                        </div>
                        
                        {showSystemInstruction && (
                            <div className="p-3 border-t border-slate-800 animate-in slide-in-from-top-1">
                                <textarea 
                                    value={settings.systemInstruction}
                                    onChange={(e) => setSettings({...settings, systemInstruction: e.target.value})}
                                    className="w-full h-32 bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-slate-300 focus:border-indigo-500 focus:outline-none resize-y custom-scrollbar leading-relaxed"
                                    placeholder="输入初始提示词，或者点击上方按钮由 AI 自动生成..."
                                />
                            </div>
                        )}
                    </div>

                    <button 
                        onClick={handleStart}
                        disabled={!title || isLoading}
                        className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl shadow-lg shadow-indigo-900/20 flex items-center justify-center gap-2 transition transform hover:scale-[1.01]"
                    >
                        {isLoading ? <span className="animate-pulse">世界观生成中...</span> : <>开始创作 <ChevronRight size={18}/></>}
                    </button>
                    
                    {/* Import Project */}
                    <div className="pt-4 border-t border-slate-800 text-center">
                        <input 
                            type="file" 
                            ref={fileInputRef} 
                            onChange={handleFileChange} 
                            accept=".json" 
                            className="hidden" 
                        />
                        <button 
                            onClick={() => fileInputRef.current?.click()}
                            className="text-xs text-slate-500 hover:text-white flex items-center justify-center gap-2 w-full py-2 hover:bg-slate-800 rounded-lg transition"
                        >
                            <Upload size={14}/> 导入已有项目 (.json)
                        </button>
                    </div>
                </div>
            </div>
            
            <div className="mt-8 text-xs text-slate-600 font-mono">
                Powered by Gemini 2.5
            </div>
        </div>
    );
};

export default WelcomeScreen;
