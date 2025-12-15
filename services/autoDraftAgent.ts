
import { NodeData, NodeType, AppSettings, AutoDraftConfig, AutoDraftStatus, MilestoneConfig, ExpansionConfig } from '../types';
import { generateNodeExpansion, refineContent, analyzeAndGenerateFix, batchValidateNodes, applyLogicFixes, generateChapterContent, validateEndingStyle, validateVolumeSpan, autoExtractWorldInfo, associateRelevantResources } from './geminiService';

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
    private globalChapterCounter: number = 0;
    
    // NEW: Session Cache to prevent infinite loops / repetitive checks in "auditAncestry"
    // Stores IDs of nodes that have passed validation in the current run
    private validatedSessionIds: Set<string> = new Set();

    constructor(
        settings: AppSettings, 
        config: AutoDraftConfig, 
        setNodes: (update: NodeUpdateFn) => void,
        getNodes: () => NodeData[],
        setStatus: (status: AutoDraftStatus) => void
    ) {
        // Inject the logging callback into settings so the Service Layer can use it
        this.settings = {
            ...settings,
            onLog: (msg) => this.logDetail(msg)
        };
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

    // New: Detailed logger for API payloads (doesn't change status text, just appends to history)
    private logDetail(message: string) {
        console.log(message);
        this.logHistory.push(message);
        // We force update status logs
        this.setStatus({
            isActive: true,
            currentStage: this.logHistory[this.logHistory.length-2] || "Processing...", // Keep previous status
            progress: 0, 
            logs: [...this.logHistory] 
        });
    }

    private generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    private sanitizeContent(text: any): string {
        if (text === null || text === undefined) return "";
        
        let clean = "";
        
        // Handle non-string inputs
        if (typeof text !== 'string') {
            if (Array.isArray(text)) {
                // If it's an array (likely string[]), join it
                clean = text.map(t => String(t)).join('\n');
            } else if (typeof text === 'object') {
                // Try to extract content field or summary field
                if (text.content && (typeof text.content === 'string' || Array.isArray(text.content))) {
                     clean = Array.isArray(text.content) ? text.content.join('\n') : text.content;
                } else if (text.summary && (typeof text.summary === 'string' || Array.isArray(text.summary))) {
                     clean = Array.isArray(text.summary) ? text.summary.join('\n') : text.summary;
                } else {
                     clean = JSON.stringify(text); // Fallback
                }
            } else {
                clean = String(text);
            }
        } else {
            clean = text;
        }
        
        // Final safety check
        if (typeof clean !== 'string') clean = String(clean);

        const codeBlockRegex = /^```(?:markdown)?\s*([\s\S]*?)\s*```$/i;
        const match = clean.match(codeBlockRegex);
        if (match && match[1]) {
            clean = match[1];
        }
        return clean.trim();
    }

    // --- STATE SYNC HELPER ---
    private async waitForNodes(ids: string[], timeout = 10000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const currentNodes = this.getNodes();
            const allFound = ids.every(id => currentNodes.some(n => n.id === id));
            if (allFound) return true;
            await delay(500); 
        }
        this.log(`[警告] 状态同步超时，部分节点未能及时检测到。`);
        return false;
    }

    // --- CONTEXT BUILDER ---
    private getFullContext(node: NodeData): string {
        const nodes = this.getNodes();
        const root = nodes.find(n => n.type === NodeType.ROOT);
        const parent = node.parentId ? nodes.find(n => n.id === node.parentId) : null;
        const prev = node.prevNodeId ? nodes.find(n => n.id === node.prevNodeId) : null;
        
        let context = `【世界观 (Root)】:\n${root?.content.slice(0, 2000) || "无"}\n\n`;
        if (parent) context += `【上级节点 (Parent - ${parent.type})】:\n${parent.summary}\n\n`;
        if (prev) context += `【前一节点 (Previous - ${prev.type})】:\n${prev.type === NodeType.CHAPTER ? prev.content.slice(-800) : prev.summary}\n\n`;
        
        return context;
    }

    // NEW Helper: Get Associated Resources as string context
    private getResourcesContext(node: NodeData): string {
        const allNodes = this.getNodes();
        const linkedIds = node.associations || [];
        if (linkedIds.length === 0) return "无关联特定资源";
        
        return linkedIds.map(id => {
            const n = allNodes.find(x => x.id === id);
            return n ? `[${n.type}] ${n.title}: ${n.summary.slice(0, 200)}` : "";
        }).filter(Boolean).join('\n');
    }

    // --- LOG RECOVERY ---
    private recoverStateFromLogs(logs: string) {
        if (!logs) return;
        this.log("正在解析日志以恢复进度...");
        const lines = logs.split('\n');
        const nodes = this.getNodes();
        let recoveredCount = 0;

        // 1. Recover "PASS" validations
        // Pattern: [智能审计] 节点 TITLE 质量达标 (PASS)。
        const passRegex = /\[智能审计\] 节点 (.*?) 质量达标 \(PASS\)/;
        
        // 2. Recover completed resource syncs
        // Pattern: [资源同步] 正在处理节点 TITLE 的资源状态... (implies intent, but "完成" is better)
        // Actually, just trusting PASS for structure nodes is the biggest win.
        
        lines.forEach(line => {
            const match = line.match(passRegex);
            if (match && match[1]) {
                const title = match[1].trim();
                const node = nodes.find(n => n.title.trim() === title);
                if (node) {
                    this.validatedSessionIds.add(node.id);
                    recoveredCount++;
                }
            }
        });

        if (recoveredCount > 0) {
            this.log(`[恢复成功] 已标记 ${recoveredCount} 个节点为通过状态，将跳过重复审计。`);
        } else {
            this.log(`[恢复提示] 未从日志中提取到有效节点状态，将全量执行。`);
        }
    }

    // --- RESOURCE LIFECYCLE MANAGEMENT ---
    // 1. Inherit (Associate Subset)
    // 2. Evolve (Extract & Update & Propagate)
    private async manageResourceLifecycle(nodeId: string, parentId: string) {
        await this.waitForNodes([nodeId, parentId]);
        const allNodes = this.getNodes();
        const node = allNodes.find(n => n.id === nodeId);
        const parent = allNodes.find(n => n.id === parentId);
        if (!node || !parent) return;

        // Optimization: If already validated in session (recovered from log), skip resource sync to save tokens?
        // Risky if resource sync failed but validation passed. 
        // Safer: Just perform it. Or check if resources are already detailed.
        // For now, we perform it as it's less expensive than full generation.

        this.log(`[资源同步] 正在处理节点 ${node.title} 的资源状态...`);

        // A. INHERITANCE: Associate relevant subset from Parent
        // Get Parent's resources
        const parentResourceIds = parent.associations || [];
        const parentResources = allNodes.filter(n => parentResourceIds.includes(n.id) && [NodeType.CHARACTER, NodeType.ITEM, NodeType.LOCATION, NodeType.FACTION].includes(n.type));
        
        let currentNodeAssociations: string[] = [];

        if (parentResources.length > 0) {
            this.log(`[资源同步] 正在从父级 (${parent.title}) 继承关联...`);
            const selectedIds = await associateRelevantResources(node.content || node.summary, parentResources, this.settings);
            // Ensure we keep valid IDs
            const validSelectedIds = selectedIds.filter(id => parentResourceIds.includes(id));
            currentNodeAssociations = validSelectedIds;
            this.updateNode(nodeId, { associations: currentNodeAssociations });
        }

        // B. EVOLUTION: Extract NEW or UPDATED resources based on Node Content
        // Wait for update to apply
        await delay(500);
        const currentResources = this.getNodes().filter(n => currentNodeAssociations.includes(n.id));
        
        this.log(`[资源同步] 正在分析增量设定...`);
        const analysis = await autoExtractWorldInfo(node.content || node.summary, currentResources, this.settings);
        
        // C. APPLY UPDATES (Create New & Update Existing)
        if (analysis.newResources.length > 0 || analysis.updates.length > 0) {
            const messages: string[] = [];
            
            // Helper for Y position
            const getNextY = (type: NodeType) => {
                const count = this.getNodes().filter(n => n.type === type).length;
                return 100 + (count * 250); 
            };

            const newResourceIds: string[] = [];

            // 1. Create New
            const newNodesToAdd: NodeData[] = [];
            analysis.newResources.forEach(res => {
                 // Double check duplicate title globally to avoid dupes
                 if (!this.getNodes().some(n => n.title === res.title && n.type === res.type)) {
                     const newId = this.generateId();
                     const type = res.type as NodeType;
                     let startX = 0;
                     if (type === NodeType.CHARACTER) startX = 0;
                     if (type === NodeType.LOCATION) startX = 300;
                     if (type === NodeType.FACTION) startX = 600;
                     if (type === NodeType.ITEM) startX = 900;

                     newNodesToAdd.push({
                         id: newId,
                         type: type,
                         title: res.title,
                         summary: res.summary,
                         content: res.summary,
                         x: startX,
                         y: getNextY(type) + (newNodesToAdd.length * 250),
                         parentId: null,
                         childrenIds: [],
                         collapsed: false,
                         associations: []
                     });
                     newResourceIds.push(newId);
                     messages.push(`[新增] ${res.title}`);
                 }
            });

            // 2. Update Existing
            analysis.updates.forEach(upd => {
                const targetNode = this.getNodes().find(n => n.id === upd.id);
                if (targetNode) {
                    this.updateNode(upd.id, { summary: upd.newSummary });
                    messages.push(`[更新] ${targetNode.title}`);
                }
            });

            // Batch Add New Nodes
            if (newNodesToAdd.length > 0) {
                this.setNodes(prev => [...prev, ...newNodesToAdd]);
                await delay(500); // Wait for state
            }

            // D. PROPAGATION (Union Logic)
            // New resources must be associated with Current Node AND Parent Node (and potentially Root, via chain)
            if (newResourceIds.length > 0) {
                // Update Current Node Associations
                const updatedCurrentAssoc = Array.from(new Set([...currentNodeAssociations, ...newResourceIds]));
                this.updateNode(nodeId, { associations: updatedCurrentAssoc });

                // Update Parent Node Associations
                const parentNode = this.getNodes().find(n => n.id === parentId);
                if (parentNode) {
                    const updatedParentAssoc = Array.from(new Set([...(parentNode.associations || []), ...newResourceIds]));
                    this.updateNode(parentId, { associations: updatedParentAssoc });
                    
                    // Propagate to ROOT if Parent is Outline
                    if (parentNode.type === NodeType.OUTLINE) {
                         const root = this.getNodes().find(n => n.type === NodeType.ROOT);
                         if (root) {
                             const updatedRootAssoc = Array.from(new Set([...(root.associations || []), ...newResourceIds]));
                             this.updateNode(root.id, { associations: updatedRootAssoc });
                         }
                    }
                }
            }

            if (messages.length > 0) {
                this.log(`[资源库更新] 完成: ${messages.join(', ')}`);
            }
        }
    }

    // --- QUALITY GATE 1: HARD EXPANSION CHECK ---
    private async expansionPhase(nodeId: string, minLength: number): Promise<boolean> {
        await this.waitForNodes([nodeId], 3000);
        const node = this.getNodes().find(n => n.id === nodeId);
        if (!node) return false;
        
        const textToCheck = node.type === NodeType.CHAPTER ? (node.content || "") : node.summary;
        
        if (textToCheck.length >= minLength) {
             return true;
        }

        this.log(`[增量扩充] 节点 ${node.title} 内容过短 (${textToCheck.length}/${minLength})，正在硬性扩充...`);
        
        let instruction = "";
        if (node.type === NodeType.CHAPTER) {
            instruction = `【正文扩充任务】
            当前内容字数：${textToCheck.length}字。
            目标字数：${minLength}字以上。
            请保留剧情逻辑，通过增加环境描写、心理描写、动作细节和对话来扩充篇幅。是"写得更细"。`;
        } else {
            instruction = `【大纲扩充任务】
            当前内容字数：${textToCheck.length}字。
            目标字数：${minLength}字以上。
            **注意：这是大纲，不要写成小说正文！**
            
            扩充方向：**增加事件的广度与密度**。
            1. 补充前因后果：这件事为什么发生？导致了什么连带反应？
            2. 增加次级事件：在核心冲突之外，是否伴随了其他小插曲？
            3. 丰富交互：主角与谁进行了交互？具体得到了什么信息或物品？
            
            请输出扩充后的事件大纲。`;
        }

        // ADDED CONTEXT
        const context = this.getFullContext(node);
        const expandedText = await refineContent(textToCheck, instruction, this.settings, context);
        const sanitized = this.sanitizeContent(expandedText);
        
        this.updateNode(nodeId, { 
            summary: node.type !== NodeType.CHAPTER ? sanitized : node.summary,
            content: node.type === NodeType.CHAPTER ? sanitized : sanitized 
        });
        
        await delay(1000); 
        return sanitized.length >= minLength;
    }

    // --- QUALITY GATE 2: VOLUME SPAN CHECK ---
    private async checkAndFixVolumeSpan(nodeId: string) {
        await this.waitForNodes([nodeId], 3000);
        const node = this.getNodes().find(n => n.id === nodeId);
        if (!node || node.type !== NodeType.OUTLINE) return;

        this.log(`[逻辑] 校验分卷跨度: ${node.title}`);
        
        const result = await validateVolumeSpan(node, this.config.plotPointsPerVolume, this.settings);
        
        if (!result.sufficient) {
            this.log(`[修复] 分卷信息密度不足，正在扩充...`);
            // ADDED CONTEXT
            const context = this.getFullContext(node);
            const rawNewSummary = await refineContent(
                node.summary, 
                `【增量信息修复】\n${result.fixInstruction}\n请在保留原有大纲的基础上，插入新的事件或副本，使其能够支撑 ${this.config.plotPointsPerVolume} 个剧情点的体量。`, 
                this.settings,
                context
            );
            const newSummary = this.sanitizeContent(rawNewSummary);
            this.updateNode(nodeId, { summary: newSummary, content: newSummary });
            await delay(1000);
        }
    }

    // --- QUALITY GATE 3: SMART OPTIMIZE (Prompt-Based) ---
    private async optimizeNode(nodeId: string, targetWordCount: number = 0, currentGlobalIndex: number = 0): Promise<boolean> {
        await this.waitForNodes([nodeId]);
        const node = this.getNodes().find(n => n.id === nodeId);
        if (!node) return false;

        const effectiveWordCount = targetWordCount > 0 ? targetWordCount : this.config.minEffectiveLength;
        const currentLen = (node.type === NodeType.CHAPTER ? node.content : node.summary).length;

        // Fast pass for non-root nodes that are long enough
        if (currentLen >= effectiveWordCount && node.type !== NodeType.ROOT && node.type !== NodeType.OUTLINE) {
             return true; 
        }

        this.log(`[智能审计] 分析节点质量: ${node.title}...`);
        const context = this.getFullContext(node);
        const resourcesContext = this.getResourcesContext(node);
        
        // Determine if this is the start of the book (Chapter 1)
        // For Root, we always want strict checks.
        // For Chapters, strictly verify index.
        const isStart = node.type === NodeType.ROOT || (node.type === NodeType.CHAPTER && currentGlobalIndex === 1);
        
        const instruction = await analyzeAndGenerateFix(
            node, 
            context, 
            resourcesContext,
            effectiveWordCount, 
            this.config.idea,
            this.settings,
            isStart
        );

        if (instruction.trim() === "PASS") {
            this.log(`[智能审计] 节点 ${node.title} 质量达标 (PASS)。`);
            return true;
        }

        this.log(`[主编修正] 执行优化指令: ${instruction.slice(0, 20)}...`);
        const currentText = node.type === NodeType.CHAPTER ? node.content : node.summary;
        const seedText = currentText || `(Empty Draft for ${node.title})`;

        // UPDATED: Pass context to refineContent for context-aware rewriting
        const rawResult = await refineContent(seedText, instruction, this.settings, context);
        const refinedText = this.sanitizeContent(rawResult);

        this.updateNode(nodeId, { 
            summary: node.type !== NodeType.CHAPTER ? refinedText : node.summary,
            content: node.type === NodeType.CHAPTER ? refinedText : refinedText 
        });
        
        await delay(1000); 
        return true;
    }

    // --- NEW: RECURSIVE ANCESTRY AUDIT (Vertical Validation) ---
    private async auditAncestry(nodeId: string) {
        // 1. Build Chain (Root -> ... -> Node)
        const chain: string[] = [];
        let currId: string | null = nodeId;
        const allNodes = this.getNodes();
        
        while(currId) {
            chain.unshift(currId);
            const n = allNodes.find(node => node.id === currId);
            currId = n?.parentId || null;
        }

        // 2. Validate Top-Down
        // Stop before current node
        for (let i = 0; i < chain.length - 1; i++) {
            if (this.stopSignal) break;
            const ancestorId = chain[i];
            const ancestor = allNodes.find(n => n.id === ancestorId);
            if (!ancestor) continue;

            // --- CACHE CHECK ---
            // If we have already validated this ancestor in this "start()" session, skip it.
            if (this.validatedSessionIds.has(ancestorId)) {
                continue;
            }

            // Define targets based on type
            let targetLen = 500;
            if (ancestor.type === NodeType.ROOT) targetLen = 1000;
            if (ancestor.type === NodeType.OUTLINE) targetLen = 800;
            if (ancestor.type === NodeType.PLOT) targetLen = 400;

            // Perform Checks
            this.log(`[递归审计] 检查祖先节点: ${ancestor.title}`);
            await this.optimizeNode(ancestorId, targetLen);
            
            if (ancestor.type === NodeType.OUTLINE) {
                await this.checkAndFixVolumeSpan(ancestorId);
            }

            await this.expansionPhase(ancestorId, targetLen);

            // Mark as validated for this session
            this.validatedSessionIds.add(ancestorId);
        }
    }

    // --- MAIN EXECUTION (Refactored to Breadth-First Strategy) ---
    
    public async start(rootNodeId: string) {
        this.stopSignal = false;
        // Reset cache at start of a new run
        this.validatedSessionIds.clear();
        
        // Recover state from logs if provided
        if (this.config.recoveryLogs) {
            this.recoverStateFromLogs(this.config.recoveryLogs);
        }
        
        try {
            this.log("启动全自动创作引擎 (广度优先模式)...");
            
            // --- PHASE 1: STRUCTURE & SKELETON (Breadth-First Validation) ---
            this.log("=== 阶段一：全书骨架铺设与校验 ===");

            // 1. Root
            if (!this.validatedSessionIds.has(rootNodeId)) {
                this.log(">> 正在校验核心世界观...");
                await this.optimizeNode(rootNodeId, 1000);
                await this.expansionPhase(rootNodeId, 1000);
                
                // [Root Resource Init] - Assume root creates initial resources.
                // We do an extraction here just in case.
                this.log(">> 正在初始化世界观资源库...");
                await this.manageResourceLifecycle(rootNodeId, rootNodeId); 
                
                this.validatedSessionIds.add(rootNodeId); // Mark root as good
            } else {
                this.log(">> [跳过] 核心世界观已在日志中确认达标。");
            }

            // 2. Ensure ALL Volumes exist
            const volumeIds = await this.ensureChildren(rootNodeId, NodeType.OUTLINE, this.config.volumeCount);
            
            // 3. Process ALL Volumes (Structure Check + RESOURCE SYNC)
            this.log(`>> 正在校验 ${volumeIds.length} 个分卷大纲...`);
            for (const volId of volumeIds) {
                if (this.stopSignal) break;
                
                if (this.validatedSessionIds.has(volId)) {
                     this.log(`>> [跳过] 分卷 ${volId} 已达标。`);
                     continue;
                }

                // Vertical Check (Uses Cache)
                await this.auditAncestry(volId);
                // Horizontal Check
                await this.checkAndFixVolumeSpan(volId);
                await this.optimizeNode(volId, 800);
                await this.expansionPhase(volId, 800);
                
                // --- BLOCKING RESOURCE SYNC FOR VOLUME ---
                await this.manageResourceLifecycle(volId, rootNodeId);

                this.validatedSessionIds.add(volId); // Mark volume as good
            }

            // 4. Process ALL Plots (for ALL Volumes)
            this.log(">> 正在铺设全书剧情节点 (Plots)...");
            for (let i = 0; i < volumeIds.length; i++) {
                if (this.stopSignal) break;
                const volId = volumeIds[i];
                
                // Ensure Plots exist
                const plotIds = await this.ensureChildren(volId, NodeType.PLOT, this.config.plotPointsPerVolume, { volumeIndex: i + 1 });
                
                // Batch Validate
                await this.batchCheckAndFix(plotIds, volId);

                // Individual Optimization + RESOURCE SYNC
                for (const plotId of plotIds) {
                    if (this.stopSignal) break;
                    
                    if (this.validatedSessionIds.has(plotId)) continue;

                    await this.auditAncestry(plotId); // Uses Cache
                    await this.optimizeNode(plotId, 400);
                    await this.expansionPhase(plotId, 400);

                    // --- BLOCKING RESOURCE SYNC FOR PLOT ---
                    await this.manageResourceLifecycle(plotId, volId);

                    this.validatedSessionIds.add(plotId); // Mark plot as good
                }
            }

            // 5. Ensure ALL Chapters exist (Placeholders)
            this.log(">> 正在初始化全书章节占位符...");
            let tempGlobalChapterIdx = 0;
            for (let i = 0; i < volumeIds.length; i++) {
                const volId = volumeIds[i];
                const volNode = this.getNodes().find(n => n.id === volId);
                const plotIds = volNode ? this.getNodes().filter(n => volNode.childrenIds.includes(n.id) && n.type === NodeType.PLOT).map(n=>n.id) : [];

                for (let j = 0; j < plotIds.length; j++) {
                    if (this.stopSignal) break;
                    const plotId = plotIds[j];
                    const cIds = await this.ensureChildren(plotId, NodeType.CHAPTER, this.config.chaptersPerPlot, {
                        volumeIndex: i + 1,
                        plotIndex: j + 1,
                        globalChapterIndex: tempGlobalChapterIdx
                    });
                    tempGlobalChapterIdx += cIds.length;
                    
                    // Audit placeholder parents once
                    for(const cid of cIds) {
                         if (this.stopSignal) break;
                         await this.auditAncestry(cid);
                    }
                }
            }

            // --- PHASE 2: WRITING PROSE (Depth-First Execution) ---
            
            this.log("=== 阶段二：全书正文撰写与精修 ===");
            
            this.globalChapterCounter = 0;

            for (let i = 0; i < volumeIds.length; i++) {
                if (this.stopSignal) break;
                const volId = volumeIds[i];
                const volNode = this.getNodes().find(n => n.id === volId);
                const plotIds = volNode ? this.getNodes().filter(n => volNode.childrenIds.includes(n.id) && n.type === NodeType.PLOT).map(n=>n.id) : []; 

                for (let j = 0; j < plotIds.length; j++) {
                    if (this.stopSignal) break;
                    const plotId = plotIds[j];
                    const plotNode = this.getNodes().find(n => n.id === plotId);
                    const chapterIds = plotNode ? this.getNodes().filter(n => plotNode.childrenIds.includes(n.id) && n.type === NodeType.CHAPTER).map(n=>n.id) : [];

                    for (let k = 0; k < chapterIds.length; k++) {
                        if (this.stopSignal) break;
                        const chapId = chapterIds[k];
                        this.globalChapterCounter++;
                        
                        await this.waitForNodes([chapId]);
                        const chapNode = this.getNodes().find(n => n.id === chapId);
                        
                        // Check if written
                        if (chapNode && (chapNode.content || "").length > 1000) {
                            continue;
                        }

                        // Ancestry Audit (Will rely on cache for speed)
                        // this.log(`[依赖检查] 正在递归效验 ${chapNode?.title} 的父级...`);
                        await this.auditAncestry(chapId);

                        // --- WRITING PIPELINE ---
                        await this.writeChapter(chapId, i+1, j+1, k+1);
                        await this.optimizeNode(chapId, this.config.wordCountPerChapter, this.globalChapterCounter);
                        await this.expansionPhase(chapId, this.config.wordCountPerChapter);
                        await this.ensureChapterEnding(chapId);
                        
                        // Mark chapter as done in cache (optional)
                        this.validatedSessionIds.add(chapId);
                    }
                }
            }
            
            this.log(this.stopSignal ? "任务已停止。" : "全书创作流程完成！");
            this.setStatus({ isActive: false, currentStage: this.stopSignal ? '已停止' : '完成', progress: 100, logs: [...this.logHistory] });

        } catch (error) {
            console.error(error);
            this.log(`发生错误: ${error}`);
            this.setStatus({ isActive: false, currentStage: 'Error', progress: 0, logs: [...this.logHistory] });
        }
    }

    // --- SUB-ROUTINES (unchanged mostly, but will inherit logging via settings) ---

    private async ensureChildren(parentId: string, type: NodeType, targetCount: number, context?: any): Promise<string[]> {
        await this.waitForNodes([parentId]);
        const parent = this.getNodes().find(n => n.id === parentId);
        if (!parent) return [];

        let children = this.getNodes().filter(n => parent.childrenIds.includes(n.id) && n.type === type);
        
        if (children.length < targetCount) {
             this.log(`[生成] 补充 ${type} 节点: ${children.length}/${targetCount}...`);
             // Generate logic
             const ids = await this.generateChildrenSequence(parentId, type, targetCount, context);
             return ids;
        }
        return children.map(n => n.id);
    }

    private async generateChildrenSequence(
        parentId: string, 
        type: NodeType, 
        totalTargetCount: number,
        context: any
    ): Promise<string[]> {
        await this.waitForNodes([parentId]);
        const parent = this.getNodes().find(n => n.id === parentId);
        if (!parent) return [];

        const existing = this.getNodes().filter(n => parent.childrenIds.includes(n.id) && n.type === type);
        const createdIds = existing.map(n => n.id);

        while(createdIds.length < totalTargetCount && !this.stopSignal) {
            const batchSize = 5;
            const remaining = totalTargetCount - createdIds.length;
            const count = Math.min(remaining, batchSize);
            
            const lastId = createdIds.length > 0 ? createdIds[createdIds.length - 1] : null;
            if (lastId) await this.waitForNodes([lastId]);
            const lastNode = lastId ? this.getNodes().find(n => n.id === lastId) : undefined;

            const milestoneConfig = (type === NodeType.OUTLINE || type === NodeType.PLOT) ? { totalPoints: totalTargetCount, generateCount: count } : undefined;
            const expansionConfig = type === NodeType.CHAPTER ? { chapterCount: count, wordCount: `${this.config.wordCountPerChapter}` } : undefined;

            const newNodesData = await generateNodeExpansion({
                currentNode: createdIds.length === 0 ? parent : (lastNode || parent),
                parentContext: createdIds.length === 0 ? undefined : parent,
                prevContext: lastNode,
                globalContext: this.getFullContext(parent), // Use full context getter
                settings: this.settings,
                task: createdIds.length === 0 ? 'EXPAND' : 'CONTINUE',
                milestoneConfig,
                expansionConfig,
                structuralContext: context
            });

            if (newNodesData.length > 0) {
                const ids = this.addNodesToState(parentId, newNodesData, lastId || undefined);
                await this.waitForNodes(ids);
                createdIds.push(...ids);
            } else {
                break; // Error or finish
            }
            await delay(1000);
        }
        return createdIds;
    }

    private async writeChapter(chapterId: string, vIdx: number, pIdx: number, cIdx: number) {
        await this.waitForNodes([chapterId]);
        const chapter = this.getNodes().find(n => n.id === chapterId);
        if (!chapter) return;

        this.log(`[写作] 生成初稿: ${chapter.title}`);
        
        // Basic write
        const content = await generateChapterContent({
            currentNode: chapter,
            parentContext: this.getNodes().find(n => n.id === chapter.parentId),
            prevContext: chapter.prevNodeId ? this.getNodes().find(n => n.id === chapter.prevNodeId) : undefined,
            globalContext: this.getFullContext(chapter),
            settings: this.settings,
            task: 'WRITE',
            structuralContext: { volumeIndex: vIdx, plotIndex: pIdx, chapterIndex: cIdx, globalChapterIndex: this.globalChapterCounter }
        });
        
        this.updateNode(chapterId, { content: this.sanitizeContent(content) });
        await delay(1000);
    }
    
    // NEW: Separated Ending Check as the Final Gate
    // FIXED: Uses slicing to preserve main content if fix is needed.
    private async ensureChapterEnding(chapterId: string) {
        await this.waitForNodes([chapterId]);
        const chapter = this.getNodes().find(n => n.id === chapterId);
        if (!chapter || !chapter.content) return;

        this.log(`[终审] 检查章节结尾风格...`);
        const checkResult = await validateEndingStyle(chapter.content, this.settings);
        
        if (!checkResult.isValid) {
            this.log(`[修正] 发现违规结尾 (预示/总结)，正在重写末尾...`);
            
            // SLICE STRATEGY:
            // Only send the last 800 chars to be refined, then stitch it back.
            // This prevents the AI from hallucinating or truncating the beginning of the chapter.
            const totalLen = chapter.content.length;
            const cutIndex = Math.max(0, totalLen - 1000); // Grab last 1000 chars context
            const safeContent = chapter.content.slice(0, cutIndex);
            const endingContent = chapter.content.slice(cutIndex);

            // Added Context here for consistency
            const context = this.getFullContext(chapter);
            
            const rawFixedEnding = await refineContent(
                endingContent, 
                `【结尾重写任务】\n**严禁出现这类描述（命中任意一条即为 Invalid）**：\n1. **预示未来**：出现了“命运的齿轮”、“他不知道未来会发生什么”、“这仅仅是个开始”、“风暴即将来临”、“他意识到***即将到来”等上帝视角的预告。\n2. **总结陈词**：出现了对本章内容的总结、感悟或升华（例如“经过这一战，他成长了...”）。\n3. **非动作/对话结尾**：结尾落在心理活动或环境描写上，而不是具体的【动作】、【对话】或【突发事件】。以上是严格禁止的，必须落在具体的动作、对话或突发事件上。\n只返回修改后的这一段修改后的完整文本\n\n${checkResult.fixInstruction}`, 
                this.settings,
                context
            );
            
            const fixedEnding = this.sanitizeContent(rawFixedEnding);
            
            // Re-stitch
            this.updateNode(chapterId, { content: safeContent + fixedEnding });
            await delay(1000);
        } else {
            this.log(`[终审] 结尾风格通过。`);
        }
    }

    private async batchCheckAndFix(nodeIds: string[], parentId: string) {
        if (nodeIds.length < 2) return;
        const allExist = await this.waitForNodes(nodeIds, 5000);
        if (!allExist) return;

        let attempts = 0;
        let hasConflicts = true;

        while(hasConflicts && attempts < 1 && !this.stopSignal) { 
            attempts++;
            const nodesToCheck = this.getNodes().filter(n => nodeIds.includes(n.id));
            const parent = this.getNodes().find(n => n.id === parentId);
            if (!parent) break;

            const result = await batchValidateNodes(nodesToCheck, parent, this.getFullContext(parent), this.settings);

            if (result.hasConflicts && result.fixes.length > 0) {
                this.log(`[逻辑修复] 发现 ${result.fixes.length} 个问题，正在修正...`);
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
            }
        }
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
