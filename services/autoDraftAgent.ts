
import { v4 as uuidv4 } from 'uuid';
import { NodeData, NodeType, AppSettings, AutoDraftConfig, AutoDraftStatus, MilestoneConfig, ExpansionConfig } from '../types';
import { generateNodeExpansion, generateRefinementPrompt, refineContent, batchValidateNodes, applyLogicFixes, generateChapterContent, validateEndingStyle } from './geminiService';
import { HIERARCHY_RULES } from '../constants';

type NodeUpdateFn = (nodes: NodeData[]) => NodeData[];

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class AutoDraftAgent {
    private settings: AppSettings;
    private config: AutoDraftConfig;
    private setNodes: (update: NodeUpdateFn) => void;
    private setStatus: (status: AutoDraftStatus) => void;
    private getNodes: () => NodeData[];
    private stopSignal: boolean = false;
    private logHistory: string[] = []; // Persist logs during session

    constructor(
        settings: AppSettings, 
        config: AutoDraftConfig, 
        setNodes: (update: NodeUpdateFn) => void,
        getNodes: () => NodeData[],
        setStatus: (status: AutoDraftStatus) => void
    ) {
        this.settings = settings;
        this.config = config;
        this.setNodes = setNodes;
        this.getNodes = getNodes;
        this.setStatus = setStatus;
    }

    public stop() {
        this.stopSignal = true;
    }

    private log(message: string) {
        const timestamp = new Date().toLocaleTimeString();
        const entry = `[${timestamp}] ${message}`;
        console.log(`[AutoAgent] ${message}`);
        this.logHistory.push(entry);

        this.setStatus({
            isActive: true,
            currentStage: message,
            progress: 0, 
            logs: [...this.logHistory] // Send full history
        });
    }

    private generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    // Core Workflow: Generate Children -> Batch Check -> Refine -> Recurse
    public async start(rootNodeId: string) {
        this.stopSignal = false;
        try {
            // 1. Refine Root (Worldview)
            this.log(`正在优化世界观设定...`);
            await this.refineNodeStepByStep(rootNodeId, `融入元素：${this.config.idea}。丰富主线设定，明确结局。`);
            await delay(1000);

            // 2. Generate Volumes (Outline)
            this.log(`正在生成 ${this.config.volumeCount} 卷大纲...`);
            const volumeIds = await this.generateChildrenSequence(rootNodeId, NodeType.OUTLINE, this.config.volumeCount);
            
            // Loop check (max 2 times) happens inside batchCheckAndFix
            await this.batchCheckAndFix(volumeIds, rootNodeId);
            await this.batchRefine(volumeIds, "优化分卷结构，确保每卷都有明确的主题和高潮。");

            // 3. Drill Down to Plots
            for (let i = 0; i < volumeIds.length; i++) {
                if (this.stopSignal) break;
                const volId = volumeIds[i];
                this.log(`正在处理第 ${i+1}/${volumeIds.length} 卷剧情点...`);
                
                // Use user config for Plot count
                const plotIds = await this.generateChildrenSequence(volId, NodeType.PLOT, this.config.plotPointsPerVolume);
                
                await this.batchCheckAndFix(plotIds, volId);
                await this.batchRefine(plotIds, "强化因果逻辑，增加冲突和反转，确保符合高密度事件要求。");
                await delay(1000);

                // 4. Drill Down to Chapters
                for (let j = 0; j < plotIds.length; j++) {
                     if (this.stopSignal) break;
                     const plotId = plotIds[j];
                     this.log(`>> 正在拆分第 ${j+1}/${plotIds.length} 个剧情点的章节...`);

                     // Use user config for Chapter count
                     const chapIds = await this.generateChildrenSequence(plotId, NodeType.CHAPTER, this.config.chaptersPerPlot);
                     
                     await this.batchCheckAndFix(chapIds, plotId);
                     await this.batchRefine(chapIds, "细化章节三事件，确保每一章都有爽点。");
                     await delay(1000);

                     // 5. Write Prose (Right Column)
                     for (const chapId of chapIds) {
                         if (this.stopSignal) break;
                         // Check if content already exists to skip
                         const chapterNode = this.getNodes().find(n => n.id === chapId);
                         if (chapterNode && chapterNode.content && chapterNode.content.length > 500) {
                             this.log(`[跳过] 章节 ${chapterNode.title} 已有正文。`);
                             continue;
                         }

                         await this.writeChapterProse(chapId);
                         await delay(2000); // Wait 2s between chapters to be safe
                     }
                }
            }
            
            if (this.stopSignal) {
                this.log("操作已手动停止。");
                this.setStatus({ isActive: false, currentStage: '已停止', progress: 0, logs: [...this.logHistory] });
            } else {
                this.log("全自动创作流程完成！");
                this.setStatus({ isActive: false, currentStage: '完成', progress: 100, logs: [...this.logHistory] });
            }

        } catch (error) {
            console.error(error);
            this.log(`发生错误: ${error}`);
            this.setStatus({ isActive: false, currentStage: 'Error', progress: 0, logs: [...this.logHistory] });
        }
    }

    // --- Helper: Generate Sequence (Start -> Continue -> Continue) ---
    private async generateChildrenSequence(parentId: string, type: NodeType, count: number): Promise<string[]> {
        const parent = this.getNodes().find(n => n.id === parentId);
        if (!parent) return [];

        // --- IDEMPOTENCY CHECK ---
        const existingChildren = this.getNodes().filter(n => parent.childrenIds.includes(n.id) && n.type === type);
        
        // If we already have enough children of this type, skip generation
        if (existingChildren.length >= count) {
            this.log(`[跳过] 节点 ${parent.title} 已存在 ${existingChildren.length} 个 ${type} 子节点 (目标 ${count})。`);
            return existingChildren.slice(0, count).map(n => n.id);
        }
        
        let createdIds: string[] = existingChildren.map(n => n.id);
        const needed = count - existingChildren.length;
        
        if (existingChildren.length > 0) {
            this.log(`[恢复] 节点 ${parent.title} 已有 ${existingChildren.length} 个 ${type}，需补全 ${needed} 个...`);
        }

        // --- CONFIG ---
        const milestoneConfig: MilestoneConfig | undefined = type === NodeType.PLOT ? {
             totalPoints: count, 
             generateCount: Math.min(needed, 5) // Generate remaining in batches
        } : (type === NodeType.OUTLINE ? {
             totalPoints: count, 
             generateCount: count 
        } : undefined);

        const expansionConfig: ExpansionConfig | undefined = type === NodeType.CHAPTER ? {
            chapterCount: count, 
            wordCount: `${this.config.wordCountPerChapter}`
        } : undefined;
        // ----------------

        // 1. Initial Generation (If no children exist)
        if (createdIds.length === 0) {
            this.log(`[生成] 正在初始化 ${type} 序列 (目标: ${count})...`);
            const initialNodes = await generateNodeExpansion({
                currentNode: parent,
                globalContext: this.getContext(parent),
                settings: this.settings,
                task: 'EXPAND',
                milestoneConfig,
                expansionConfig
            });

            if (initialNodes.length > 0) {
                const addedIds = this.addNodesToState(parentId, initialNodes);
                createdIds.push(...addedIds);
            }
            await delay(1000);
        }

        // 2. Loop "Continue" until count reached
        while (createdIds.length < count && !this.stopSignal) {
             const lastId = createdIds[createdIds.length - 1];
             const lastNode = this.getNodes().find(n => n.id === lastId);
             if (!lastNode) break;

             this.log(`[生成] 正在推进 ${type} 序列 (${createdIds.length}/${count})...`);
             
             const nextNodes = await generateNodeExpansion({
                 currentNode: lastNode,
                 prevContext: lastNode,
                 globalContext: this.getContext(parent),
                 settings: this.settings,
                 task: 'CONTINUE'
             });

             if (nextNodes.length > 0) {
                 const addedIds = this.addNodesToState(parentId, nextNodes, lastId);
                 createdIds.push(...addedIds);
             } else {
                 break; 
             }
             await delay(1000);
        }
        
        return createdIds;
    }

    // --- Helper: Batch Logic Check & Fix (Iterative) ---
    private async batchCheckAndFix(nodeIds: string[], parentId: string) {
        if (nodeIds.length < 2) return;
        
        // Optional: Skip check if we are resuming and assume existing are good?
        // For now, let's run checks to be safe, but limit to 1 attempt on resume might be better.
        // We will stick to 2 attempts but rely on user to stop if they are happy.
        
        let attempts = 0;
        let hasConflicts = true;

        // Loop checking up to 2 times
        while(hasConflicts && attempts < 2 && !this.stopSignal) {
            attempts++;
            this.log(`[检查] 正在进行逻辑自检 (第 ${attempts} 轮)...`);
            
            const nodesToCheck = this.getNodes().filter(n => nodeIds.includes(n.id));
            const parent = this.getNodes().find(n => n.id === parentId);
            
            if (!parent) break;

            const result = await batchValidateNodes(nodesToCheck, parent, this.getContext(parent), this.settings);

            if (result.hasConflicts && result.fixes.length > 0) {
                this.log(`[修复] 发现 ${result.fixes.length} 个逻辑/参数问题，正在靶向修正...`);
                
                for (const fix of result.fixes) {
                    if (this.stopSignal) break;
                    const node = this.getNodes().find(n => n.id === fix.id);
                    if (node) {
                        // Apply targeted fix (refining instead of regenerating from scratch)
                        const newSummary = await applyLogicFixes(node, fix.instruction, this.settings);
                        this.updateNode(node.id, { summary: newSummary, content: node.type !== NodeType.CHAPTER ? newSummary : node.content });
                        await delay(1000);
                    }
                }
            } else {
                hasConflicts = false;
                this.log(`[检查] 逻辑检查通过。`);
            }
            await delay(1000);
        }
    }

    // --- Helper: Two-Step Refinement (Prompt -> Content) ---
    private async refineNodeStepByStep(nodeId: string, intent: string) {
        const node = this.getNodes().find(n => n.id === nodeId);
        if (!node) return;

        // Step 1: Optimize Prompt
        this.log(`[优化] 正在设计优化指令 (${node.title})...`);
        const optimizedPrompt = await generateRefinementPrompt(node.type, node.summary, intent, this.settings);

        // Step 2: Optimize Content
        this.log(`[优化] 正在重写内容 (${node.title})...`);
        const newSummary = await refineContent(node.summary, optimizedPrompt, this.settings);
        
        this.updateNode(nodeId, { summary: newSummary, content: node.type !== NodeType.CHAPTER ? newSummary : node.content });
    }

    private async batchRefine(nodeIds: string[], intent: string) {
        for (const id of nodeIds) {
            if (this.stopSignal) break;
            await this.refineNodeStepByStep(id, intent);
            await delay(500);
        }
    }

    // --- Helper: Write Prose with Iterative Style Check ---
    private async writeChapterProse(chapterId: string) {
        const chapter = this.getNodes().find(n => n.id === chapterId);
        if (!chapter) return;

        this.log(`[写作] 正在撰写正文: ${chapter.title}...`);
        
        const prevNode = chapter.prevNodeId ? this.getNodes().find(n => n.id === chapter.prevNodeId) : undefined;
        
        let prose = await generateChapterContent({
            currentNode: chapter,
            parentContext: this.getNodes().find(n => n.id === chapter.parentId),
            prevContext: prevNode, 
            globalContext: this.getContext(chapter),
            settings: this.settings,
            task: 'WRITE'
        });

        if (!prose || prose.length < 50) {
             console.warn(`[AutoAgent] Warning: Generated prose for ${chapterId} was empty or too short.`);
             return;
        }

        // --- Iterative Style Check (Endings) ---
        let attempts = 0;
        let isValid = false;

        while (!isValid && attempts < 2 && !this.stopSignal) {
            const checkResult = await validateEndingStyle(prose, this.settings);
            
            if (checkResult.isValid) {
                isValid = true;
            } else {
                attempts++;
                this.log(`[修正] 章节结尾风格违规 (预示性/总结性)，正在重写...`);
                // Use refineContent to fix the specific issue targeting the ending
                prose = await refineContent(prose, `严禁预示未来或总结，请修改结尾。${checkResult.fixInstruction}`, this.settings);
                await delay(1000);
            }
        }

        this.updateNode(chapterId, { content: prose });
    }

    // --- Utilities ---

    private getContext(node: NodeData): string {
        // Collect root + resources
        const nodes = this.getNodes();
        const root = nodes.find(n => n.type === NodeType.ROOT);
        const resources = nodes.filter(n => [NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(n.type));
        return `【世界观】${root?.content.slice(0, 1000)}\n【资源库】${resources.map(r => r.title + ':' + r.summary).join('\n')}`;
    }

    private addNodesToState(parentId: string, newNodesData: Partial<NodeData>[], afterNodeId?: string): string[] {
        const parent = this.getNodes().find(n => n.id === parentId);
        if (!parent) return [];

        // Calculate visual position
        const existingChildren = this.getNodes().filter(n => parent.childrenIds.includes(n.id));
        const startY = existingChildren.length > 0 ? Math.max(...existingChildren.map(c => c.y)) + 250 : parent.y;
        
        let prevId = afterNodeId || (existingChildren.length > 0 ? existingChildren[existingChildren.length-1].id : null);
        
        const newNodes: NodeData[] = [];
        const ids: string[] = [];

        newNodesData.forEach((data, idx) => {
            const id = this.generateId();
            ids.push(id);
            newNodes.push({
                id: id,
                type: data.type || NodeType.PLOT,
                title: data.title || 'Node',
                summary: data.summary || '',
                content: data.summary || '', // Default content to summary
                x: parent.x + 400,
                y: startY + (idx * 250),
                parentId: parentId,
                childrenIds: [],
                prevNodeId: prevId,
                collapsed: false,
                associations: parent.associations || []
            });
            prevId = id;
        });

        this.setNodes(prev => {
            let updated = [...prev];
            // Link parent
            updated = updated.map(n => n.id === parentId ? { ...n, childrenIds: [...n.childrenIds, ...ids], collapsed: false } : n);
            // Link sibling chain (if inserting) - Simplified for append-only logic used here
            return [...updated, ...newNodes];
        });

        return ids;
    }

    private updateNode(id: string, updates: Partial<NodeData>) {
        this.setNodes(prev => prev.map(n => n.id === id ? { ...n, ...updates } : n));
    }
}
