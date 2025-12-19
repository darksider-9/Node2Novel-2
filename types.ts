
export enum NodeType {
    ROOT = 'ROOT',
    OUTLINE = 'OUTLINE',
    PLOT = 'PLOT',
    CHAPTER = 'CHAPTER',
    CHARACTER = 'CHARACTER',
    ITEM = 'ITEM',
    LOCATION = 'LOCATION',
    FACTION = 'FACTION'
}

export interface NodeData {
    id: string;
    type: NodeType;
    title: string;
    summary: string;
    content: string;
    x: number;
    y: number;
    parentId: string | null;
    childrenIds: string[];
    prevNodeId?: string | null;
    collapsed: boolean;
    associations?: string[]; // IDs of associated resources
}

export interface AppSettings {
    apiKey: string;
    baseUrl: string;
    modelName: string;
    temperature: number;
    thinkingBudget: number;
    novelStyle: string;
    systemInstruction: string;
    onLog?: (msg: string, type?: 'req' | 'res' | 'info') => void;
}

export interface ExpansionConfig {
    chapterCount?: number;
    wordCount?: string | number;
}

export interface MilestoneConfig {
    totalPoints: number;
    generateCount: number;
    strategy?: 'linear' | 'spanning'; // NEW: Support keyframe generation
}

export interface AIRequestParams {
    currentNode: NodeData;
    globalContext: string;
    settings: AppSettings;
    task: 'EXPAND' | 'CONTINUE' | 'WRITE';
    parentContext?: NodeData;
    prevContext?: NodeData;
    nextContext?: NodeData;
    expansionConfig?: ExpansionConfig;
    milestoneConfig?: MilestoneConfig;
    structuralContext?: {
        volumeIndex?: number;
        plotIndex?: number;
        chapterIndex?: number;
        globalChapterIndex?: number;
    };
    storyContext?: string;
}

export interface LogicValidationResult {
    valid: boolean;
    score: number;
    issues: string[];
    suggestions: string[];
}

export interface LoreUpdateSuggestion {
    targetId: string;
    newSummary: string;
    reason: string;
}

export interface WorldStateAnalysis {
    newResources: { type: string, title: string, summary: string }[];
    updates: { id: string, newSummary: string, changeLog: string }[];
    mentionedIds: string[];
}

export type ViewMode = 'story' | 'resource';

export type GenerationDepth = 'OUTLINE' | 'PLOT' | 'CHAPTER' | 'PROSE';

export interface AutoDraftConfig {
    idea: string; // Core user idea/elements
    volumeCount: number;
    plotPointsPerVolume: number;
    chaptersPerPlot: number;
    wordCountPerChapter: number;
    minEffectiveLength: number; // NEW: Threshold for "quality check"
    recoveryLogs?: string; // NEW: Paste logs to resume progress
    
    // NEW: Plot Analysis Agent Config
    enablePlotAnalysis?: boolean;
    pacing?: 'Fast' | 'Normal' | 'Slow'; 
    
    // NEW: Generation Depth Control
    targetDepth: GenerationDepth;
}

export interface AutoDraftStatus {
    isActive: boolean;
    currentStage: string; // e.g., "正在架构第一卷..."
    progress: number; // 0-100
    logs: string[];
}
