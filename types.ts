
export enum NodeType {
  ROOT = 'ROOT',
  OUTLINE = 'OUTLINE',
  PLOT = 'PLOT',
  CHAPTER = 'CHAPTER',
  CHARACTER = 'CHARACTER',
  ITEM = 'ITEM',
  LOCATION = 'LOCATION', // New: Maps, Dungeons
  FACTION = 'FACTION'    // New: Sects, Organizations
}

export type ViewMode = 'story' | 'resource';

export interface NodeData {
  id: string;
  type: NodeType;
  title: string;
  summary: string;
  content: string; // The specific content based on type (Worldview, Detailed Outline, Detailed Arc, Prose)
  x: number;
  y: number;
  parentId: string | null;
  childrenIds: string[];
  // For chain structure (linked list logic for chapters/plots)
  prevNodeId?: string | null;
  
  // New: Visual state
  collapsed?: boolean;
  
  // New: Resource linking (Characters/Items IDs associated with this node)
  associations?: string[];
}

export interface AppSettings {
  apiKey: string; // Added user input API Key
  baseUrl: string;
  modelName: string;
  temperature: number;
  systemInstruction: string;
  novelStyle: string;
  thinkingBudget: number; // New: Controls how much the model "thinks"
}

export interface ExpansionConfig {
    chapterCount: number;
    wordCount: string;
}

export interface MilestoneConfig {
    totalPoints: number; // e.g. 60 plot points in a volume
    generateCount: number; // e.g. generate 5 landmarks
}

export interface AIRequestParams {
  currentNode: NodeData;
  parentContext?: NodeData;
  prevContext?: NodeData;
  nextContext?: NodeData;
  globalContext: string; // Plain text context of associated items
  storyContext?: string; // New: Rolling summary of previous chapters
  settings: AppSettings;
  task: 'EXPAND' | 'WRITE' | 'BRAINSTORM' | 'CONTINUE' | 'POLISH' | 'SYNC_LORE' | 'BATCH_CHECK' | 'BATCH_FIX';
  
  // New: Structural Context for precise positioning
  structuralContext?: {
      volumeIndex?: number;
      plotIndex?: number;
      chapterIndex?: number; // Relative to plot
      globalChapterIndex?: number; // Absolute in book
      totalWordCountTarget?: number; // For validation
  };

  // User defined configs for Plot -> Chapter breakdown
  expansionConfig?: ExpansionConfig;
  
  // User defined configs for Outline -> Plot distribution
  milestoneConfig?: MilestoneConfig;
  
  // For Polish task
  selection?: string;
  
  // For Batch tasks
  batchNodes?: NodeData[];
}

export interface LogicValidationResult {
    valid: boolean;
    issues: string[];
    suggestions: string[];
    score: number;
}

export interface LoreUpdateSuggestion {
    targetId: string; // ID of character/item
    originalSummary: string;
    newSummary: string;
    reason: string;
}

// New: Result from background analysis
export interface WorldStateAnalysis {
    newResources: {
        type: NodeType;
        title: string;
        summary: string;
    }[];
    updates: {
        id: string;
        newSummary: string;
        changeLog: string;
    }[];
    mentionedIds: string[];
}

// --- AUTO DRAFT TYPES ---
export interface AutoDraftConfig {
    idea: string; // Core user idea/elements
    volumeCount: number;
    plotPointsPerVolume: number;
    chaptersPerPlot: number;
    wordCountPerChapter: number;
}

export interface AutoDraftStatus {
    isActive: boolean;
    currentStage: string; // e.g., "正在架构第一卷..."
    progress: number; // 0-100
    logs: string[];
}
