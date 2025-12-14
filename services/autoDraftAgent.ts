
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
    private logHistory: string[] = []; 
    private globalChapterCounter: number = 0; // NEW: Track absolute chapter number

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
            logs: [...this.logHistory] 
        });
    }

    private generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    private sanitizeContent(text: string): string {
        if (!text) return "";
        let clean = text;
        const codeBlockRegex = /^```(?:markdown)?\s*([\s\S]*?)\s*```$/i;
        const match = clean.match(codeBlockRegex);
        if (match && match[1]) {
            clean = match[1];
        }
        const prefixes = [
            /^Here is (?:the )?(?:revised|optimized|rewritten|updated)?\s*(?:content|text|story|outline|plot)?(?:[:：])?\s*/i,
            /^Sure(?:,)?\s*(?:here is|I have)?.*[:：]\s*/i,
            /^Okay(?:,)?\s*/i,
            /^好的(?:，)?(?:这是|为您)?.*[:：]\s*/,
            /^Optimized version[:：]\s*/i,
            /^Revised content[:：]\s*/i,
            /^Modified text[:：]\s*/i
        ];
        for (const prefix of prefixes) {
            clean = clean.replace(prefix, "");
        }
        return clean.trim();
    }

    // --- QUALITY GATE (HARD METRICS) ---
    private async qualityGate(nodeId: string, minLength: number): Promise<boolean> {
        const node = this.getNodes().find(n => n.id === nodeId);
        if (!node) return false;
        
        // Use summary for Outline/Plot, content for Chapter
        const textToCheck = node.type === NodeType.CHAPTER ? (node.content || "") : node.summary;
        
        if (textToCheck.length < minLength) {
            this.log(`[质量门禁] 节点 ${node.title} 字数不足 (${textToCheck.length} < ${minLength})。自动触发扩写...`);
            
            // Auto-Refine to expand
            const instruction = `当前字数仅 ${textToCheck.length}，远低于要求的 ${minLength}。请务必大幅扩充细节，补充环境、心理、动作描写，确保字数达标。`;
            const expandedText = await refineContent(textToCheck, instruction, this.settings);
            const sanitized = this.sanitizeContent(expandedText);
            
            this.updateNode(nodeId, { 
                summary: node.type !== NodeType.CHAPTER ? sanitized : node.summary,
                content: node.type === NodeType.CHAPTER ? sanitized : sanitized // Sync content for outline types too
            });
            
            return sanitized.length >= minLength; // Check again
        }
        return true;
    }

    public async start(rootNodeId: string) {
        this.stopSignal = false;
        this.globalChapterCounter = 0; // Reset
        
        try {
            // 1. Refine Root (Worldview)
            this.log(`正在优化世界观设定...`);
            await this.refineNodeStepByStep(rootNodeId, `融入元素：${this.config.idea}。丰富主线设定，明确结局。`);
            await delay(1000);

            // 2. Generate Volumes (Outline)
            this.log(`正在生成 ${this.config.volumeCount} 卷大纲...`);
            const volumeIds = await this.generateChildrenSequence(rootNodeId, NodeType.OUTLINE, this.config.volumeCount, { volumeIndex: 1 });
            
            // Loop check (max 2 times) happens inside batchCheckAndFix
            await this.batchCheckAndFix(volumeIds, rootNodeId);
            
            // HARD METRIC CHECK FOR OUTLINES (>2000)
            for (const volId of volumeIds) await this.qualityGate(volId, 2000);

            await this.batchRefine(volumeIds, "优化分卷结构，确保每卷都有明确的主题和高潮，包含地图跨越。");

            // 3. Drill Down to Plots
            for (let i = 0; i < volumeIds.length; i++) {
                if (this.stopSignal) break;
                const volId = volumeIds[i];
                this.log(`正在处理第 ${i+1}/${volumeIds.length} 卷剧情点...`);
                
                // Use user config for Plot count
                const plotIds = await this.generateChildrenSequence(volId, NodeType.PLOT, this.config.plotPointsPerVolume, { volumeIndex: i + 1 });
                
                await this.batchCheckAndFix(plotIds, volId);
                
                // HARD METRIC CHECK FOR PLOTS (>2000)
                // This is critical: Plots must contain ALL info (Entities, Items) for the chapters
                for (const plotId of plotIds) await this.qualityGate(plotId, 2000);
                
                await this.batchRefine(plotIds, "强化因果逻辑，增加冲突和反转。必须包含所有新人物、新物品的设定细节。");
                await delay(1000);

                // --- NEW: Bottom-Up Consistency Check ---
                // After Plots are solidified, we update the Volume Outline to reflect the detailed plots
                // This is a simplified consistency check
                // this.log(`[一致性] 正在根据生成的剧情点反向修正分卷大纲...`);
                // (Implementation omitted for brevity, but logically belongs here)

                // 4. Drill Down to Chapters
                for (let j = 0; j < plotIds.length; j++) {
                     if (this.stopSignal) break;
                     const plotId = plotIds[j];
                     this.log(`>> 正在拆分第 ${j+1}/${plotIds.length} 个剧情点的章节...`);

                     // Calculate Chapter Indices
                     const startChapterIndex = this.globalChapterCounter + 1;
                     
                     // Use user config for Chapter count
                     const chapIds = await this.generateChildrenSequence(plotId, NodeType.CHAPTER, this.config.chaptersPerPlot, { 
                         volumeIndex: i + 1, 
                         plotIndex: j + 1,
                         globalChapterIndex: startChapterIndex
                     });
                     
                     // Increase Global Counter
                     this.globalChapterCounter += chapIds.length;

                     await this.batchCheckAndFix(chapIds, plotId);
                     
                     // HARD METRIC CHECK FOR CHAPTER OUTLINES (>500)
                     for (const cId of chapIds) {
                         const node = this.getNodes().find(n => n.id === cId);
                         if (node && node.summary.length < 500) {
                             const expanded = await refineContent(node.summary, "扩充章节细纲至500字以上，补充事件细节。", this.settings);
                             this.updateNode(cId, { summary: this.sanitizeContent(expanded) });
                         }
                     }
                     
                     await delay(1000);

                     // 5. Write Prose (Right Column)
                     for (let k = 0; k < chapIds.length; k++) {
                         if (this.stopSignal) break;
                         const chapId = chapIds[k];
                         
                         // Check if content already exists to skip
                         const chapterNode = this.getNodes().find(n => n.id === chapId);
                         if (chapterNode && chapterNode.content && chapterNode.content.length > 500) {
                             this.log(`[跳过] 章节 ${chapterNode.title} 已有正文。`);
                             continue;
                         }

                         // Pass Context: Global Chapter Index
                         await this.writeChapterProse(chapId, {
                             volumeIndex: i + 1,
                             plotIndex: j + 1,
                             chapterIndex: k + 1,
                             globalChapterIndex: startChapterIndex + k
                         });
                         
                         // HARD METRIC CHECK FOR PROSE (>2000)
                         await this.qualityGate(chapId, 2000);
                         
                         await delay(2000); 
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

    // --- Helper: Generate Sequence ---
    private async generateChildrenSequence(
        parentId: string, 
        type: NodeType, 
        count: number,
        context: { volumeIndex?: number, plotIndex?: number, globalChapterIndex?: number }
    ): Promise<string[]> {
        const parent = this.getNodes().find(n => n.id === parentId);
        if (!parent) return [];

        // --- IDEMPOTENCY CHECK ---
        const existingChildren = this.getNodes().filter(n => parent.childrenIds.includes(n.id) && n.type === type);
        
        if (existingChildren.length >= count) {
            this.log(`[跳过] 节点 ${parent.title} 已存在 ${existingChildren.length} 个 ${type} 子节点 (目标 ${count})。`);
            return existingChildren.slice(0, count).map(n => n.id);
        }
        
        let createdIds: string[] = existingChildren.map(n => n.id);
        const needed = count - existingChildren.length;
        
        if (existingChildren.length > 0) {
            this.log(`[恢复] 节点 ${parent.title} 已有 ${existingChildren.length} 个 ${type}，需补全 ${needed} 个...`);
        }

        const milestoneConfig: MilestoneConfig | undefined = type === NodeType.PLOT ? {
             totalPoints: count, 
             generateCount: Math.min(needed, 5) 
        } : (type === NodeType.OUTLINE ? {
             totalPoints: count, 
             generateCount: count 
        } : undefined);

        const expansionConfig: ExpansionConfig | undefined = type === NodeType.CHAPTER ? {
            chapterCount: count, 
            wordCount: `${this.config.wordCountPerChapter}`
        } : undefined;

        // 1. Initial Generation
        if (createdIds.length === 0) {
            this.log(`[生成] 正在初始化 ${type} 序列 (目标: ${count})...`);
            const initialNodes = await generateNodeExpansion({
                currentNode: parent,
                globalContext: this.getContext(parent),
                settings: this.settings,
                task: 'EXPAND',
                milestoneConfig,
                expansionConfig,
                structuralContext: context // Pass Context
            });

            if (initialNodes.length > 0) {
                const addedIds = this.addNodesToState(parentId, initialNodes);
                createdIds.push(...addedIds);
            }
            await delay(1000);
        }

        // 2. Loop "Continue"
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
                 task: 'CONTINUE',
                 structuralContext: context // Pass Context
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
        
        let attempts = 0;
        let hasConflicts = true;

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
                        const rawNewSummary = await applyLogicFixes(node, fix.instruction, this.settings);
                        const newSummary = this.sanitizeContent(rawNewSummary);
                        
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

    private async refineNodeStepByStep(nodeId: string, intent: string) {
        const node = this.getNodes().find(n => n.id === nodeId);
        if (!node) return;

        // Step 1: Optimize Prompt
        this.log(`[优化] 正在设计优化指令 (${node.title})...`);
        const optimizedPrompt = await generateRefinementPrompt(node.type, node.summary, intent, this.settings);

        // Step 2: Optimize Content and SANITIZE
        this.log(`[优化] 正在重写内容 (${node.title})...`);
        const rawNewSummary = await refineContent(node.summary, optimizedPrompt, this.settings);
        const newSummary = this.sanitizeContent(rawNewSummary);
        
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
    private async writeChapterProse(chapterId: string, context: { volumeIndex: number, plotIndex: number, chapterIndex: number, globalChapterIndex: number }) {
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
            task: 'WRITE',
            structuralContext: context // Pass structural context (Global Chapter Index)
        });

        prose = this.sanitizeContent(prose);

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
                const rawFixed = await refineContent(prose, `严禁预示未来或总结，请修改结尾。${checkResult.fixInstruction}`, this.settings);
                prose = this.sanitizeContent(rawFixed);
                await delay(1000);
            }
        }

        this.updateNode(chapterId, { content: prose });
    }

    // --- Utilities ---

    private getContext(node: NodeData): string {
        const nodes = this.getNodes();
        const root = nodes.find(n => n.type === NodeType.ROOT);
        const resources = nodes.filter(n => [NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(n.type));
        return `【世界观】${root?.content.slice(0, 1000)}\n【资源库】${resources.map(r => r.title + ':' + r.summary).join('\n')}`;
    }

    private addNodesToState(parentId: string, newNodesData: Partial<NodeData>[], afterNodeId?: string): string[] {
        const parent = this.getNodes().find(n => n.id === parentId);
        if (!parent) return [];

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
                summary: this.sanitizeContent(data.summary || ''), 
                content: this.sanitizeContent(data.summary || ''), 
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
            updated = updated.map(n => n.id === parentId ? { ...n, childrenIds: [...n.childrenIds, ...ids], collapsed: false } : n);
            return [...updated, ...newNodes];
        });

        return ids;
    }

    private updateNode(id: string, updates: Partial<NodeData>) {
        this.setNodes(prev => prev.map(n => n.id === id ? { ...n, ...updates } : n));
    }
}
