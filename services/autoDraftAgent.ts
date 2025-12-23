
import { NodeData, NodeType, AppSettings, AutoDraftConfig, AutoDraftStatus, MilestoneConfig, ExpansionConfig } from '../types';
import { generateNodeExpansion, refineContent, analyzeAndGenerateFix, batchValidateNodes, validateFullSequence, applyLogicFixes, generateChapterContent, validateEndingStyle, validateVolumeSpan, autoExtractWorldInfo, associateRelevantResources, consultStructuralArchitect, analyzePlotPacing } from './geminiService';

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

    // --- HELPER: CHECK NODE STATUS ---
    private isNodeDone(nodeId: string, flag: string): boolean {
        const node = this.getNodes().find(n => n.id === nodeId);
        return !!node?.status?.[flag];
    }
    
    private markNodeDone(nodeId: string, flag: string) {
        this.updateNode(nodeId, {}, { [flag]: true });
    }

    // --- RESOURCE LIFECYCLE MANAGEMENT ---
    // 1. Inherit (Associate Subset)
    // 2. Evolve (Extract & Update & Propagate)
    private async manageResourceLifecycle(nodeId: string, parentId: string) {
        if (this.isNodeDone(nodeId, 'res_sync')) {
            this.log(`[跳过] 资源同步已完成: ${nodeId.slice(-4)}`);
            return;
        }

        await this.waitForNodes([nodeId, parentId]);
        const allNodes = this.getNodes();
        const node = allNodes.find(n => n.id === nodeId);
        const parent = allNodes.find(n => n.id === parentId);
        if (!node || !parent) return;

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
                         associations: [],
                         status: {}
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
        
        this.markNodeDone(nodeId, 'res_sync');
    }

    // --- QUALITY GATE 1: HARD EXPANSION CHECK ---
    private async expansionPhase(nodeId: string, minLength: number): Promise<boolean> {
        // NOTE: Expansion Phase is merged into 'opt_quality' step for status tracking
        // We won't strictly skip it unless optimized, but for simplicity, we assume
        // optimization covers length check.
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
        if (this.isNodeDone(nodeId, 'val_struct')) {
            this.log(`[跳过] 结构校验已完成: ${nodeId.slice(-4)}`);
            return;
        }

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
        this.markNodeDone(nodeId, 'val_struct');
    }

    // --- QUALITY GATE 3: SMART OPTIMIZE (Prompt-Based) ---
    private async optimizeNode(nodeId: string, targetWordCount: number = 0, currentGlobalIndex: number = 0): Promise<boolean> {
        if (this.isNodeDone(nodeId, 'opt_quality')) {
            this.log(`[跳过] 内容精修已完成: ${nodeId.slice(-4)}`);
            return true;
        }

        await this.waitForNodes([nodeId]);
        const node = this.getNodes().find(n => n.id === nodeId);
        if (!node) return false;

        const effectiveWordCount = targetWordCount > 0 ? targetWordCount : this.config.minEffectiveLength;
        const currentLen = (node.type === NodeType.CHAPTER ? node.content : node.summary).length;

        // Fast pass for non-root nodes that are long enough
        if (currentLen >= effectiveWordCount && node.type !== NodeType.ROOT && node.type !== NodeType.OUTLINE) {
             this.markNodeDone(nodeId, 'opt_quality');
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
            this.markNodeDone(nodeId, 'opt_quality');
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
        this.markNodeDone(nodeId, 'opt_quality');
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

            // Define targets based on type
            let targetLen = 500;
            if (ancestor.type === NodeType.ROOT) targetLen = 1000;
            if (ancestor.type === NodeType.OUTLINE) targetLen = 800;
            if (ancestor.type === NodeType.PLOT) targetLen = 400;

            // Perform Checks based on persisted status
            this.log(`[递归审计] 检查祖先节点: ${ancestor.title}`);
            
            if (ancestor.type === NodeType.OUTLINE) {
                await this.checkAndFixVolumeSpan(ancestorId);
            }
            
            await this.optimizeNode(ancestorId, targetLen);
            await this.expansionPhase(ancestorId, targetLen); // Length check
        }
    }
    
    // --- NEW: GAP ANALYSIS (Plot Pacing Agent) ---
    private async refinePlotSequence(plotIds: string[], parentId: string) {
        if (!this.config.enablePlotAnalysis || plotIds.length < 2) return;
        
        // Pacing check usually shouldn't be skipped if we added new nodes, but for now we won't add a strict flag for parent pacing check
        // Or we could attach 'val_struct' to Parent Outline for Pacing? 
        // Let's assume Pacing Check is part of 'val_struct' for Outline if we wanted strictness.
        // For now, we run it if not explicitly skipped.

        await this.waitForNodes([parentId, ...plotIds]);
        const allNodes = this.getNodes();
        const parent = allNodes.find(n => n.id === parentId);
        const plots = allNodes.filter(n => plotIds.includes(n.id)).sort((a,b) => a.y - b.y); // Ensure order
        
        if(!parent) return;

        this.log(`[节奏分析 Agent] 检查分卷 ${parent.title} 的剧情连贯性...`);
        
        const pacing = this.config.pacing || 'Normal';
        const analysis = await analyzePlotPacing(plots, parent, pacing, this.settings);
        
        if (analysis.insertAfterIds.length > 0) {
            this.log(`[节奏优化] 建议插入 ${analysis.insertAfterIds.length} 个过渡剧情点。`);
            
            for (let i = 0; i < analysis.insertAfterIds.length; i++) {
                if (this.stopSignal) break;
                const afterId = analysis.insertAfterIds[i];
                const summary = analysis.summaries[i];
                
                // Add Sibling Logic
                const prevNode = this.getNodes().find(n => n.id === afterId);
                if (prevNode) {
                    const newId = this.generateId();
                    const newNode: NodeData = {
                        id: newId,
                        type: NodeType.PLOT,
                        title: `[过渡] ${summary.slice(0, 10)}...`,
                        summary: summary,
                        content: summary,
                        x: prevNode.x,
                        y: prevNode.y + 125, // temp offset
                        parentId: parentId,
                        childrenIds: [],
                        prevNodeId: afterId,
                        associations: prevNode.associations,
                        collapsed: false,
                        status: {}
                    };
                    
                    this.log(`[自动插入] 过渡节点: ${newNode.title}`);
                    
                    // Insert into state (logic similar to App.handleAddSibling)
                    this.setNodes(prev => {
                        let updated = [...prev];
                        // Link next node to new node
                        const nextNode = updated.find(n => n.prevNodeId === afterId);
                        if(nextNode) nextNode.prevNodeId = newId;
                        
                        // Link parent
                        const p = updated.find(n => n.id === parentId);
                        if(p) p.childrenIds = [...p.childrenIds, newId];
                        
                        return [...updated, newNode];
                    });
                    
                    await delay(500);
                }
            }
        } else {
             this.log(`[节奏分析] 剧情连贯，节奏符合 (${pacing})。`);
        }
    }

    // --- MAIN EXECUTION (Refactored to Breadth-First Strategy) ---
    
    public async start(rootNodeId: string) {
        this.stopSignal = false;
        // removed local set clear
        
        try {
            this.log("启动全自动创作引擎 (优化加强版)...");
            if (this.config.enablePlotAnalysis) {
                this.log(`已启用智能情节设计 Agent (节奏: ${this.config.pacing || 'Normal'})`);
            }
            // Use targetDepth instead of outlineMode
            this.log(`🔥 生成目标层级: ${this.config.targetDepth} | 策略: ${this.config.generationStrategy === 'spanning' ? '关键帧插值' : '线性连贯(One-Pass)'}`);
            
            // --- PHASE 1: STRUCTURE & SKELETON (Breadth-First Validation) ---
            this.log("=== 阶段一：全书骨架铺设与校验 ===");

            // 1. Root
            this.log(">> 正在校验核心世界观...");
            await this.optimizeNode(rootNodeId, 1000);
            await this.expansionPhase(rootNodeId, 1000); // Length check
            
            // [Root Resource Init]
            this.log(">> 正在初始化世界观资源库...");
            await this.manageResourceLifecycle(rootNodeId, rootNodeId); 
            
            this.markNodeDone(rootNodeId, 'exp_children'); // Marked implicitly after next step

            // 2. Ensure ALL Volumes exist
            // UPGRADE: Use Spanning Generation for Volume Structure (Head & Tail) if count >= 3
            if (!this.isNodeDone(rootNodeId, 'exp_children')) {
                this.log(">> 正在规划全书分卷结构 (Head/Tail Strategy)...");
                let targetVolumeCount = this.config.volumeCount;
                await this.ensureChildren(rootNodeId, NodeType.OUTLINE, targetVolumeCount);
                this.markNodeDone(rootNodeId, 'exp_children');
            } else {
                this.log(">> [跳过] 分卷规划已完成。");
            }
            
            const root = this.getNodes().find(n => n.id === rootNodeId);
            let volumeIds = this.getNodes().filter(n => root?.childrenIds.includes(n.id) && n.type === NodeType.OUTLINE).map(n => n.id);

            // NEW: Filter by selected scope if provided
            if (this.config.selectedVolumeIds && this.config.selectedVolumeIds.length > 0) {
                const scope = this.config.selectedVolumeIds;
                this.log(`>> [Scope] 仅处理选中的 ${scope.length} 个分卷...`);
                volumeIds = volumeIds.filter(id => scope.includes(id));
            }

            // 3. Process ALL Volumes (Structure Check + RESOURCE SYNC)
            this.log(`>> 正在优化 ${volumeIds.length} 个分卷大纲...`);
            for (const volId of volumeIds) {
                if (this.stopSignal) break;
                
                // Vertical Check
                await this.auditAncestry(volId);
                // Horizontal Check
                await this.checkAndFixVolumeSpan(volId);
                await this.optimizeNode(volId, 800);
                await this.expansionPhase(volId, 800);
                
                // --- BLOCKING RESOURCE SYNC FOR VOLUME ---
                await this.manageResourceLifecycle(volId, rootNodeId);
            }

            // --- DEPTH CHECK: OUTLINE ---
            if (this.config.targetDepth === 'OUTLINE') {
                this.log("✅ 已达到目标深度：分卷规划 (OUTLINE)。任务完成。");
                this.setStatus({ isActive: false, currentStage: '完成 (分卷规划)', progress: 100, logs: [...this.logHistory] });
                return;
            }

            // 4. Process ALL Plots (for ALL Volumes)
            this.log(">> 正在铺设全书剧情节点 (Plots)...");
            for (let i = 0; i < volumeIds.length; i++) {
                if (this.stopSignal) break;
                const volId = volumeIds[i];
                
                if (!this.isNodeDone(volId, 'exp_children')) {
                    const volNode = this.getNodes().find(n => n.id === volId);
                    
                    // DYNAMIC AGENT: Consult Structural Architect for Plot Count
                    let targetPlotCount = this.config.plotPointsPerVolume;
                    if (this.config.enablePlotAnalysis && volNode) {
                        this.log(`[结构规划 Agent] 正在分析分卷 "${volNode.title}" 的体量...`);
                        const advice = await consultStructuralArchitect(
                            volNode, 
                            NodeType.PLOT, 
                            this.config.pacing || 'Normal', 
                            targetPlotCount, 
                            this.settings
                        );
                        this.log(`[结构规划] 建议生成 ${advice.count} 个剧情点。理由：${advice.reason}`);
                        targetPlotCount = advice.count;
                    }

                    // Ensure Plots exist (Strategy applied inside ensureChildren)
                    const plotIds = await this.ensureChildren(volId, NodeType.PLOT, targetPlotCount, { volumeIndex: i + 1 });
                    
                    // DYNAMIC AGENT: Pacing Check (Gap Filling)
                    // Only apply pacing gap fill if NOT using One-Pass (One-Pass is assumed coherent)
                    if (this.config.enablePlotAnalysis && this.config.generationStrategy !== 'one_pass') {
                        await this.refinePlotSequence(plotIds, volId);
                    }
                    this.markNodeDone(volId, 'exp_children');
                } else {
                    this.log(`>> [跳过] 分卷 ${volId} 剧情推演已完成。`);
                }

                // Re-fetch Plot IDs (in case gaps were inserted)
                const finalVolNode = this.getNodes().find(n => n.id === volId);
                const finalPlotIds = finalVolNode ? this.getNodes().filter(n => finalVolNode.childrenIds.includes(n.id) && n.type === NodeType.PLOT).map(n=>n.id) : [];

                // Batch Validate + Global Chain Check (Moved inside function logic)
                // UPDATED: Now supports Deletion
                await this.batchCheckAndFix(finalPlotIds, volId);

                // Individual Optimization + RESOURCE SYNC
                for (const plotId of finalPlotIds) {
                    if (this.stopSignal) break;
                    // Re-check existence as batchCheckAndFix might have deleted some
                    if (!this.getNodes().some(n => n.id === plotId)) continue; 

                    await this.auditAncestry(plotId); 
                    await this.optimizeNode(plotId, 400);
                    await this.expansionPhase(plotId, 400);

                    // --- BLOCKING RESOURCE SYNC FOR PLOT ---
                    await this.manageResourceLifecycle(plotId, volId);
                }
            }

            // --- DEPTH CHECK: PLOT ---
            if (this.config.targetDepth === 'PLOT') {
                this.log("✅ 已达到目标深度：剧情推演 (PLOT)。任务完成。");
                this.setStatus({ isActive: false, currentStage: '完成 (剧情推演)', progress: 100, logs: [...this.logHistory] });
                return;
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
                    
                    if (!this.isNodeDone(plotId, 'exp_children')) {
                        const plotNode = this.getNodes().find(n => n.id === plotId);

                        // DYNAMIC AGENT: Consult Structural Architect for Chapter Count
                        let targetChapCount = this.config.chaptersPerPlot;
                        if (this.config.enablePlotAnalysis && plotNode) {
                            const advice = await consultStructuralArchitect(
                                plotNode,
                                NodeType.CHAPTER,
                                this.config.pacing || 'Normal',
                                targetChapCount,
                                this.settings
                            );
                            targetChapCount = advice.count;
                        }

                        const cIds = await this.ensureChildren(plotId, NodeType.CHAPTER, targetChapCount, {
                            volumeIndex: i + 1,
                            plotIndex: j + 1,
                            globalChapterIndex: tempGlobalChapterIdx
                        });
                        tempGlobalChapterIdx += cIds.length;
                        this.markNodeDone(plotId, 'exp_children');
                    } else {
                        // Just count them up for index
                        const plotNode = this.getNodes().find(n => n.id === plotId);
                        const cCount = plotNode ? this.getNodes().filter(n => plotNode.childrenIds.includes(n.id) && n.type === NodeType.CHAPTER).length : 0;
                        tempGlobalChapterIdx += cCount;
                    }
                }
            }

            // --- DEPTH CHECK: CHAPTER (OUTLINE) ---
            if (this.config.targetDepth === 'CHAPTER') {
                this.log("✅ 已达到目标深度：章节细纲 (CHAPTER OUTLINE)。跳过正文撰写。");
                this.setStatus({ isActive: false, currentStage: '完成 (章节细纲)', progress: 100, logs: [...this.logHistory] });
                return;
            }

            // --- PHASE 2: WRITING PROSE (Depth-First Execution) ---
            // Only proceeds if targetDepth === 'PROSE'
            
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
                        
                        // Check Write status
                        if (this.isNodeDone(chapId, 'con_draft')) {
                             this.log(`[跳过] 章节 ${chapId.slice(-4)} 已撰写。`);
                             continue;
                        }

                        await this.waitForNodes([chapId]);
                        const chapNode = this.getNodes().find(n => n.id === chapId);
                        
                        // Check if manually written
                        if (chapNode && (chapNode.content || "").length > 1000) {
                             this.markNodeDone(chapId, 'con_draft');
                             continue;
                        }

                        await this.auditAncestry(chapId);

                        // --- WRITING PIPELINE ---
                        // We are already in PROSE mode if we are here
                        await this.writeChapter(chapId, i+1, j+1, k+1);
                        await this.optimizeNode(chapId, this.config.wordCountPerChapter, this.globalChapterCounter);
                        await this.expansionPhase(chapId, this.config.wordCountPerChapter);
                        await this.ensureChapterEnding(chapId);
                        
                        this.markNodeDone(chapId, 'con_draft');
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

        // --- STRATEGY SWITCHING ---
        // 1. Spanning (Keyframes + Infill) -> Only if "spanning" selected AND fresh start
        // 2. One-Pass (Continuous Batch) -> Only if "one_pass" selected AND fresh start AND type is PLOT
        // 3. Linear Batch (Default) -> Append logic
        
        const isFreshStart = createdIds.length === 0;
        const useSpanning = this.config.generationStrategy === 'spanning' && isFreshStart && ((type === NodeType.PLOT && totalTargetCount >= 5) || (type === NodeType.OUTLINE && totalTargetCount >= 3));
        const useOnePass = this.config.generationStrategy === 'one_pass' && isFreshStart && type === NodeType.PLOT;

        if (useSpanning) {
             return this.generateKeyframesAndFill(parentId, type, totalTargetCount, context);
        }

        // ONE-PASS MODE: Ask for ALL nodes at once with specific prompt
        if (useOnePass) {
            this.log(`[结构生成] 采用 "One-Pass" 策略，一次性生成 ${totalTargetCount} 个剧情点...`);
            const nodesData = await generateNodeExpansion({
                currentNode: parent,
                parentContext: undefined,
                prevContext: undefined,
                globalContext: this.getFullContext(parent),
                settings: this.settings,
                task: 'EXPAND',
                // Milestone config configured to ask for ALL with strategy 'one_pass'
                milestoneConfig: { totalPoints: totalTargetCount, generateCount: totalTargetCount, strategy: 'one_pass' },
                structuralContext: context
            });
            
            if (nodesData.length > 0) {
                 const ids = this.addNodesToState(parentId, nodesData);
                 await this.waitForNodes(ids);
                 createdIds.push(...ids);
                 return createdIds;
            }
            // If failed, fall through to linear loop
        }

        while(createdIds.length < totalTargetCount && !this.stopSignal) {
            const batchSize = 5;
            const remaining = totalTargetCount - createdIds.length;
            const count = Math.min(remaining, batchSize);
            
            const lastId = createdIds.length > 0 ? createdIds[createdIds.length - 1] : null;
            if (lastId) await this.waitForNodes([lastId]);
            const lastNode = lastId ? this.getNodes().find(n => n.id === lastId) : undefined;

            const milestoneConfig: MilestoneConfig | undefined = (type === NodeType.OUTLINE || type === NodeType.PLOT) ? { 
                totalPoints: totalTargetCount, 
                generateCount: count,
                strategy: 'linear_batch' 
            } : undefined;
            const expansionConfig = type === NodeType.CHAPTER ? { chapterCount: count, wordCount: `${this.config.wordCountPerChapter}` } : undefined;

            const newNodesData = await generateNodeExpansion({
                currentNode: createdIds.length === 0 ? parent : (lastNode || parent),
                parentContext: createdIds.length === 0 ? undefined : parent,
                prevContext: lastNode,
                globalContext: this.getFullContext(parent),
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

    // RENAMED & UPGRADED: Generic Keyframe Strategy for Volume & Plot
    private async generateKeyframesAndFill(
        parentId: string,
        type: NodeType,
        totalTargetCount: number,
        context: any
    ): Promise<string[]> {
        const parent = this.getNodes().find(n => n.id === parentId)!;
        const typeLabel = type === NodeType.OUTLINE ? '分卷(Outline)' : '剧情点(Plot)';
        
        // 1. Generate Keyframes spanning the container
        this.log(`[结构生成] 正在规划 "${parent.title}" 的关键节点骨架 (Keyframes for ${typeLabel})...`);
        
        // Use 3 keyframes for Volumes, 5 for Plots typically
        const keyframeCount = type === NodeType.OUTLINE ? 3 : 5;
        const actualKeyframeCount = Math.min(totalTargetCount, keyframeCount);

        const keyframeConfig: MilestoneConfig = { 
            totalPoints: totalTargetCount, 
            generateCount: actualKeyframeCount,
            strategy: 'spanning' 
        };

        const keyframesData = await generateNodeExpansion({
            currentNode: parent,
            parentContext: undefined,
            prevContext: undefined,
            globalContext: this.getFullContext(parent),
            settings: this.settings,
            task: 'EXPAND', // EXPAND from Parent
            milestoneConfig: keyframeConfig,
            structuralContext: context
        });

        if (keyframesData.length === 0) return [];

        let ids = this.addNodesToState(parentId, keyframesData);
        await this.waitForNodes(ids);

        // 2. Infill Gaps
        // Current state: [K1, K2, K3...]
        // We need to fill between them to reach totalTargetCount.
        
        let currentIds = [...ids];
        const intervals = currentIds.length - 1;
        if (intervals > 0) {
            const remainingTotal = totalTargetCount - currentIds.length;
            const perIntervalBase = Math.floor(remainingTotal / intervals);
            let remainder = remainingTotal % intervals;

            if (remainingTotal > 0) {
                this.log(`[结构生成] 正在填充关键节点之间的空隙...`);
    
                for (let i = 0; i < intervals; i++) {
                    if (this.stopSignal) break;
                    
                    const startId = currentIds[i]; // K1
                    const endId = currentIds[i+1]; // K2
                    
                    const startNode = this.getNodes().find(n => n.id === startId);
                    const endNode = this.getNodes().find(n => n.id === endId);
                    
                    const countForThisGap = perIntervalBase + (remainder > 0 ? 1 : 0);
                    if (remainder > 0) remainder--;
                    
                    if (countForThisGap <= 0) continue;
    
                    this.log(`[填充剧情] 在 ${startNode?.title.slice(0,8)}... 和 ${endNode?.title.slice(0,8)}... 之间生成 ${countForThisGap} 个过渡节点`);
    
                    const fillData = await generateNodeExpansion({
                        currentNode: startNode!,
                        parentContext: parent,
                        prevContext: startNode!, // Start of gap
                        nextContext: endNode!,   // End of gap
                        globalContext: this.getFullContext(parent),
                        settings: this.settings,
                        task: 'CONTINUE', // Use CONTINUE for Infill
                        milestoneConfig: { totalPoints: countForThisGap, generateCount: countForThisGap, strategy: 'linear_batch' },
                        structuralContext: context
                    });
                    
                    if (fillData.length > 0) {
                        const newIds = this.addNodesToState(parentId, fillData, startId); // Insert after startId
                        await this.waitForNodes(newIds);
                    }
                    
                    await delay(1000);
                }
            }
        }
        
        // 3. Final Count Check & Fallback Fill
        // This handles cases where Keyframe/Infill logic yielded fewer nodes than requested
        const finalParent = this.getNodes().find(n => n.id === parentId);
        const allChildren = this.getNodes().filter(n => finalParent?.childrenIds.includes(n.id) && n.type === type);
        
        if (allChildren.length < totalTargetCount) {
            this.log(`[数量补齐] 当前节点数 ${allChildren.length} < 目标 ${totalTargetCount}，正在执行线性补齐...`);
            
            const remaining = totalTargetCount - allChildren.length;
            const lastId = allChildren.length > 0 ? allChildren[allChildren.length - 1].id : null;
            const lastNode = lastId ? this.getNodes().find(n => n.id === lastId) : parent;
            
            // Linear append for the missing ones
             const fillData = await generateNodeExpansion({
                currentNode: lastNode!,
                parentContext: parent,
                prevContext: lastNode!,
                globalContext: this.getFullContext(parent),
                settings: this.settings,
                task: 'CONTINUE', // Continue from last
                milestoneConfig: { totalPoints: remaining, generateCount: remaining, strategy: 'linear_batch' },
                structuralContext: context
            });
            
            if (fillData.length > 0) {
                const newIds = this.addNodesToState(parentId, fillData, lastId || undefined); 
                await this.waitForNodes(newIds);
            }
        }

        // Return all children of parent, sorted
        const finalParentRefetched = this.getNodes().find(n => n.id === parentId);
        return this.getNodes().filter(n => finalParentRefetched?.childrenIds.includes(n.id) && n.type === type).map(n => n.id);
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
        if (this.isNodeDone(chapterId, 'val_end')) return;

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
        this.markNodeDone(chapterId, 'val_end');
    }

    // --- UPDATED: BATCH CHECK WITH DELETE HANDLING ---
    private async batchCheckAndFix(nodeIds: string[], parentId: string) {
        if (nodeIds.length < 2) return;
        
        // BATCHING: Split checks into chunks of 10
        const BATCH_SIZE = 10;
        
        for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
            if (this.stopSignal) break;
            
            // Refresh nodeIds to handle potential deletions from previous batches
            const currentNodes = this.getNodes().filter(n => nodeIds.includes(n.id));
            if (currentNodes.length === 0) continue;

            const batchIds = nodeIds.slice(i, i + BATCH_SIZE).filter(id => this.getNodes().some(n => n.id === id));
            if (batchIds.length === 0) continue;
            
            // CONTEXT OVERLAP: Get last 2 nodes from previous batch as read-only context
            const prevContextIds = i >= 2 ? nodeIds.slice(i - 2, i) : [];
            const prevContextNodes = this.getNodes().filter(n => prevContextIds.includes(n.id));

            // Phase 1: Standard Individual/Pairwise check (Logic)
            if (this.isNodeDone(batchIds[batchIds.length-1], 'val_struct')) continue;
            
            const allExist = await this.waitForNodes(batchIds, 5000);
            if (!allExist) continue;

            let attempts = 0;
            let hasConflicts = true;

            this.log(`[逻辑校验] 正在检查第 ${i+1}-${Math.min(i+BATCH_SIZE, nodeIds.length)} 个节点 (含重叠上下文)...`);

            while(hasConflicts && attempts < 1 && !this.stopSignal) { 
                attempts++;
                const nodesToCheck = this.getNodes().filter(n => batchIds.includes(n.id));
                const parent = this.getNodes().find(n => n.id === parentId);
                if (!parent) break;

                const result = await batchValidateNodes(nodesToCheck, parent, prevContextNodes, this.getFullContext(parent), this.settings);

                if (result.hasConflicts && result.fixes.length > 0) {
                    this.log(`[逻辑修复] 发现 ${result.fixes.length} 个建议。`);
                    for (const fix of result.fixes) {
                        if (this.stopSignal) break;
                        
                        // NEW: HANDLE DELETE
                        if (fix.delete) {
                            const targetNode = this.getNodes().find(n => n.id === fix.id);
                            if (targetNode) {
                                this.log(`[节点裁撤] 删除无用节点: ${targetNode.title}`);
                                this.deleteNode(fix.id);
                                
                                // Remove from batchIds immediately so we don't process it further or mark it done
                                const idx = batchIds.indexOf(fix.id);
                                if (idx > -1) batchIds.splice(idx, 1);
                            }
                            continue;
                        }

                        const node = this.getNodes().find(n => n.id === fix.id);
                        if (node) {
                            // Fix now returns { title, summary }
                            const fixResult = await applyLogicFixes(node, fix.instruction, this.settings);
                            const newSummary = this.sanitizeContent(fixResult.summary);
                            
                            // Check if title was updated
                            const updates: Partial<NodeData> = { 
                                summary: newSummary, 
                                content: node.type !== NodeType.CHAPTER ? newSummary : node.content 
                            };
                            if (fix.newTitle || fixResult.title !== node.title) {
                                updates.title = fix.newTitle || fixResult.title;
                                this.log(`[标题更新] ${node.title} -> ${updates.title}`);
                            }

                            this.updateNode(node.id, updates);
                            await delay(1000);
                        }
                    }
                } else {
                    hasConflicts = false;
                }
            }
            
            // Mark all in batch as done
            batchIds.forEach(id => this.markNodeDone(id, 'val_struct'));
        }

        // Phase 2: GLOBAL SEQUENCE CHECK (After ALL batches are done for this parent)
        // This is now OUTSIDE the loop, running once for the entire sequence.
        const parent = this.getNodes().find(n => n.id === parentId);
        const allChildren = this.getNodes().filter(n => nodeIds.includes(n.id)); // Should exclude deleted ones naturally by getNodes()
        
        if (parent && allChildren.length > 3) {
            this.log(`[全局审计] 正在对分卷 "${parent.title}" 的所有剧情点进行最终断层检查...`);
            const fullCheck = await validateFullSequence(allChildren, parent, this.settings);
            
            if (fullCheck.hasGap && fullCheck.fixSuggestions.length > 0) {
                this.log(`[全局修复] 发现剧情断层: ${fullCheck.gapAnalysis.slice(0, 50)}...`);
                for (const sugg of fullCheck.fixSuggestions) {
                    const targetNode = this.getNodes().find(n => n.id === sugg.targetId);
                    if (targetNode) {
                            const fixResult = await applyLogicFixes(targetNode, sugg.instruction, this.settings);
                            const newSummary = this.sanitizeContent(fixResult.summary);
                            
                            const updates: Partial<NodeData> = { 
                                summary: newSummary, 
                                content: targetNode.type !== NodeType.CHAPTER ? newSummary : targetNode.content 
                            };
                            if (sugg.newTitle || fixResult.title !== targetNode.title) {
                                updates.title = sugg.newTitle || fixResult.title;
                                this.log(`[标题更新] ${targetNode.title} -> ${updates.title}`);
                            }

                            this.updateNode(targetNode.id, updates);
                            this.log(`[修复执行] 已修正节点: ${updates.title}`);
                            await delay(1000);
                    }
                }
            } else {
                this.log(`[全局审计] 剧情链完整无断层。`);
            }
        }
    }
    
    // NEW: Helper for deletion
    private deleteNode(id: string) {
        this.setNodes(prev => {
            const nodeToDelete = prev.find(n => n.id === id);
            const prevNodeId = nodeToDelete?.prevNodeId;
            const nextNode = prev.find(n => n.prevNodeId === id);
            const remaining = prev.filter(n => n.id !== id);
            
            // Re-link
            return remaining.map(n => {
                let newNode = { ...n };
                // Remove from parent childrenIds
                if (newNode.childrenIds.includes(id)) {
                    newNode.childrenIds = newNode.childrenIds.filter(cid => cid !== id);
                }
                // Fix linked list
                if (n.id === nextNode?.id && prevNodeId) {
                    newNode.prevNodeId = prevNodeId;
                } else if (n.id === nextNode?.id) {
                    newNode.prevNodeId = null;
                }
                return newNode;
            });
        });
    }

    private addNodesToState(parentId: string, newNodesData: Partial<NodeData>[], afterNodeId?: string): string[] {
        const parent = this.getNodes().find(n => n.id === parentId);
        if (!parent) return [];

        const existingChildren = this.getNodes().filter(n => parent.childrenIds.includes(n.id));
        
        // Calculate insert index
        let insertIndex = existingChildren.length;
        let prevId = existingChildren.length > 0 ? existingChildren[existingChildren.length-1].id : null;
        let nextId: string | null = null;
        let startY = existingChildren.length > 0 ? Math.max(...existingChildren.map(c => c.y)) + 250 : parent.y;

        if (afterNodeId) {
            const idx = existingChildren.findIndex(n => n.id === afterNodeId);
            if (idx !== -1) {
                insertIndex = idx + 1;
                prevId = afterNodeId;
                if (idx < existingChildren.length - 1) {
                    nextId = existingChildren[idx + 1].id;
                }
                // Update StartY to be after previous node
                const prevNode = existingChildren[idx];
                startY = prevNode.y + 250;
            }
        }
        
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
                prevNodeId: prevId, // Chain Link
                collapsed: false,
                associations: parent.associations || [],
                status: {}
            });
            prevId = id;
        });

        // If we inserted in the middle, link the last new node to the old next node
        if (nextId && newNodes.length > 0) {
             // We'll update the nextId node's prevNodeId in the state update below
        }

        this.setNodes(prev => {
            let updated = [...prev];
            
            // 1. Update Parent Children List (Insert)
            const p = updated.find(n => n.id === parentId);
            if (p) {
                const newChildrenIds = [...p.childrenIds];
                // We need to find the correct index in the raw ID list
                // If appending, it's easy. If inserting, we used 'afterNodeId'.
                if (afterNodeId) {
                     const rawIdx = newChildrenIds.indexOf(afterNodeId);
                     if (rawIdx !== -1) {
                         newChildrenIds.splice(rawIdx + 1, 0, ...ids);
                     } else {
                         newChildrenIds.push(...ids);
                     }
                } else {
                     newChildrenIds.push(...ids);
                }
                updated = updated.map(n => n.id === parentId ? { ...n, childrenIds: newChildrenIds, collapsed: false } : n);
            }

            // 2. Link Next Node (if any) to the last new node
            if (nextId) {
                const lastNewId = ids[ids.length - 1];
                updated = updated.map(n => n.id === nextId ? { ...n, prevNodeId: lastNewId } : n);
            }
            
            return [...updated, ...newNodes];
        });

        return ids;
    }

    private updateNode(id: string, updates: Partial<NodeData>, statusUpdates?: Record<string, boolean>) {
        this.setNodes(prev => prev.map(n => {
            if (n.id === id) {
                const mergedStatus = statusUpdates ? { ...(n.status || {}), ...statusUpdates } : n.status;
                return { ...n, ...updates, status: mergedStatus };
            }
            return n;
        }));
    }
}
