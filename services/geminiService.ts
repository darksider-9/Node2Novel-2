
import { AIRequestParams, NodeType, NodeData, LogicValidationResult, LoreUpdateSuggestion, AppSettings, WorldStateAnalysis } from '../types';

// --- GLOBAL REQUEST QUEUE (Rate Limiter) ---
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let apiRequestQueue: Promise<any> = Promise.resolve();

/**
 * Universal OpenAI-Compatible API Caller
 * Replaces the Google SDK to support standard /chat/completions endpoints (OneAPI, proxies, etc.)
 */
const callOpenAI = async (
    messages: { role: string, content: string }[], 
    settings: AppSettings, 
    jsonMode: boolean = false
): Promise<string> => {
    
    // Append to global queue to ensure sequential execution
    const queueResult = apiRequestQueue.then(async () => {
        // 1. Rate Limit Padding (2s)
        await delay(2000);

        // Auto-resolve API Key: Use settings first, then env var
        let apiKey = settings.apiKey;
        if (!apiKey && typeof process !== 'undefined' && process.env.API_KEY) {
            apiKey = process.env.API_KEY;
        }

        // Auto-resolve Base URL: Handle Gemini specific endpoint if not provided
        let baseUrl = settings.baseUrl;
        if (!baseUrl || baseUrl.trim() === '') {
            // If using a Gemini model without a custom base URL, default to Google's OpenAI-compatible endpoint
            if (settings.modelName.toLowerCase().includes('gemini')) {
                 baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
            } else {
                 baseUrl = 'https://api.openai.com/v1';
            }
        }
        baseUrl = baseUrl.replace(/\/$/, '');
        
        const url = `${baseUrl}/chat/completions`;
        
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        const body: any = {
            model: settings.modelName,
            messages: messages,
            temperature: settings.temperature,
            stream: false // Non-streaming for logic simplicity in this version
        };

        // Handle JSON Mode
        if (jsonMode) {
            body.response_format = { type: "json_object" };
            // Ensure system prompt explicitly asks for JSON to avoid provider errors
            if (messages[0].role === 'system') {
                messages[0].content += " \nIMPORTANT: You must output valid JSON only.";
            }
        }

        // --- LOGGING REQUEST ---
        if (settings.onLog) {
            const userMsg = messages.find(m => m.role === 'user')?.content || '';
            const sysMsg = messages.find(m => m.role === 'system')?.content || '';
            settings.onLog(`\n🔵 [AI REQUEST] Model: ${settings.modelName}\n[System]: ${sysMsg.slice(0, 200)}...\n[User Prompt]:\n${userMsg}\n--------------------------------`, 'req');
        }

        // Retry Logic
        const retries = 3;
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body)
                });

                if (!response.ok) {
                    const errText = await response.text();
                    // Handle Rate Limits (429) specifically
                    if (response.status === 429) {
                         const waitTime = 2000 * (2 ** i);
                         const warning = `[API] 429 Rate Limit. Retrying in ${waitTime}ms...`;
                         console.warn(warning);
                         if(settings.onLog) settings.onLog(warning, 'info');
                         await delay(waitTime);
                         continue;
                    }
                    throw new Error(`API Error ${response.status}: ${errText}`);
                }

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || "";
                
                // --- LOGGING RESPONSE ---
                if (settings.onLog) {
                    settings.onLog(`\n🟢 [AI RESPONSE]\n${content}\n--------------------------------`, 'res');
                }

                return content;

            } catch (error: any) {
                console.error(`Attempt ${i+1} failed:`, error);
                if (settings.onLog) settings.onLog(`[API Error] Attempt ${i+1}: ${error.message}`, 'info');
                if (i === retries - 1) throw error;
                await delay(2000);
            }
        }
        return "";
    });

    // Advance Queue
    apiRequestQueue = queueResult.catch(() => {});
    return queueResult;
};

// --- NEW AGENT: Content Coverage Analyzer ---
/**
 * 核心功能：内容覆盖率分析 Agent
 * 分析父节点内容是否已被子节点完全覆盖，并建议缺失的子节点。
 */
export const analyzeContentCoverage = async (
    parent: NodeData,
    children: NodeData[],
    settings: AppSettings
): Promise<{ missingNodes: { title: string, summary: string, insertAfterId: string | null }[] }> => {
    const childrenText = children.map((c, i) => `[节点 ${i + 1} ID:${c.id}] ${c.title}: ${c.summary}`).join('\n');
    
    const prompt = `
        角色：【网文逻辑审计师】
        任务：对比“父级总纲”与“已生成的子节点列表”，检查是否存在剧情断层或内容缺失。
        
        【父级总纲】：${parent.title} - ${parent.summary}
        
        【当前已有的子节点列表】：
        ${childrenText}
        
        **分析原则**：
        1. **覆盖率检查**：父级总纲中提到的每一个关键事件、冲突、转折点，是否都在子节点中得到了体现？
        2. **逻辑连续性**：相邻子节点之间是否存在明显的逻辑跳跃（例如从A地直接跳到了B地，但中间没有任何过程描述）？
        3. **非重复性**：不要对已经有的节点进行改动，只寻找缺失的部分。
        
        **输出要求**：
        - 如果发现父级中有内容未被子级覆盖，请生成新的子节点来填补空隙。
        - 明确指出新节点应该插入在哪个已有节点 ID 之后（insertAfterId）。如果是插在开头，该值为 null。
        - 仅输出确实缺失的部分。如果没有缺失，返回空数组。

        **Output JSON Format Required:**
        { 
          "missingNodes": [ 
            { "title": "string", "summary": "string", "insertAfterId": "string_or_null" } 
          ] 
        }
    `;

    try {
        const text = await callOpenAI([{ role: "user", content: prompt }], settings, true);
        return JSON.parse(text);
    } catch (e) {
        return { missingNodes: [] };
    }
};

// --- 1. Initialization & System ---

export const generateInitialWorldview = async (title: string, settings: AppSettings): Promise<string> => {
    const prompt = `
        任务：为小说《${title}》初始化核心世界观设定。
        流派：${settings.novelStyle}
        
        请根据上述流派的常见套路和核心爽点，构建一个详细的世界观框架。
        必须包含以下要素：
        1. 【世界背景】：宏观地理、时代背景、核心矛盾。
        2. 【力量体系】：具体的等级划分（如练气、筑基...或 S级、A级...），升级方式。
        3. 【核心势力】：主要的正派、反派、中立组织。
        4. 【主角设定】：姓名、金手指/外挂、初始动机。
        5. 【主线宏愿】：故事的终极目标。

        输出要求：
        - 结构清晰，使用 Markdown 格式。
        - 既然是${settings.novelStyle}，请确保术语地道（例如修仙要有灵根、丹田；赛博要有义体、公司）。
        - 字数控制在 1000-2000 字之间。越详细越好。
    `;

    const messages = [
        { role: "system", content: settings.systemInstruction },
        { role: "user", content: prompt }
    ];

    try {
        return await callOpenAI(messages, settings);
    } catch (e) {
        console.error("Init Worldview Error", e);
        throw e; // Propagate error to UI
    }
};

export const optimizeSystemInstruction = async (title: string, style: string, currentInstruction: string, settings: AppSettings): Promise<string> => {
    const prompt = `
        任务：优化小说创作助手的系统提示词 (System Prompt)。
        
        小说标题：${title}
        小说流派：${style}
        当前基础提示词：${currentInstruction}
        
        目标：
        请根据标题和流派，重写并扩充系统提示词。
        1. 定义 AI 的角色（金牌网文编辑/大神作家）。
        2. 强调该流派（${style}）的核心爽点、常见套路、避坑指南和术语风格。
        3. 强调【事件广度】：在构思大纲时，不要沉迷于单一场景的描写，而要列出大量发生的事件。
        4. 保持指令清晰，直接返回优化后的提示词内容，不要包含其他解释。
    `;

    return await callOpenAI([{ role: "user", content: prompt }], settings);
};

// --- NEW AGENT: Structural Architect & Pacing Analyst ---

export const consultStructuralArchitect = async (
    parentNode: NodeData,
    targetChildType: NodeType,
    pacing: 'Fast' | 'Normal' | 'Slow',
    baseCount: number, // User's manual config as a hint
    settings: AppSettings
): Promise<{ count: number, reason: string }> => {
    const prompt = `
        角色：【资深网文结构规划师】
        任务：动态决定下一层级所需的节点数量。
        
        【上级节点】：[${parentNode.type}] ${parentNode.title}
        【上级内容】：${parentNode.summary}
        
        【规划目标】：生成子节点类型为 ${targetChildType}。
        【用户期望节奏】：${pacing} (Fast=爽文/快节奏, Normal=标准, Slow=慢热/铺垫多)。
        【用户基准建议】：${baseCount} 个。
        
        请分析上级内容的体量和信息密度，结合节奏要求，给出一个合理的子节点数量建议。
        
        **决策原则**：
        1. **Plot -> Chapter (最重要)**：
           - 基本原则一个小事件一章，但是出现新的都要交代一些物品地区人物背景铺垫，不能凭空产生。
           - 如果剧情点只是一个单一小事件（如“获得宝物”），${pacing==='Slow'?'2':'1'} 章即可。
           - 如果是过渡剧情（赶路/日常），${pacing==='Fast'?'1':'2-3'} 章（制造悬念串联）。
           - 如果是中大型事件/高潮（如“决战BOSS/宗门大比”），必须多章铺垫。Fast节奏给 3-4 章，Slow节奏给 5-7 章。
        2. **Outline -> Plot**：
           - 确保覆盖分卷的所有关键转折。如果事件过多，Fast节奏下就是默认生成的内容，而Slow节奏增加支线。
        3. **Root -> Outline**：
           - 规划全书分卷数。合理划分分卷数量

        请输出建议的数量 (count) 和简短理由 (reason)。
        
        **Output JSON Format Required:**
        { "count": number, "reason": "string" }
    `;

    try {
        const text = await callOpenAI([
            { role: "system", content: settings.systemInstruction },
            { role: "user", content: prompt }
        ], settings, true);
        return JSON.parse(text);
    } catch (e) {
        return { count: baseCount, reason: "Analysis failed, using default." };
    }
};

export const analyzePlotPacing = async (
    plotNodes: NodeData[],
    parentOutline: NodeData,
    pacing: 'Fast' | 'Normal' | 'Slow',
    settings: AppSettings
): Promise<{ insertAfterIds: string[], summaries: string[] }> => {
    if (plotNodes.length < 2) return { insertAfterIds: [], summaries: [] };

    const sequence = plotNodes.map(n => `[ID:${n.id}] ${n.title}: ${n.summary}`).join('\n');
    
    const prompt = `
        角色：【网文节奏精修师】
        任务：检查当前分卷的剧情点序列，判断是否需要插入“过渡剧情”以调节节奏。
        
        【当前分卷】：${parentOutline.title}
        【剧情序列】：
        ${sequence}
        
        【期望节奏】：${pacing}
        
        **分析原则**：
        1. **连贯性检查**：如果两个剧情点之间跨度过大（例如从“凡人村”直接跳到“仙界大战”），必须插入过渡。
        2. **节奏控制**：
           - 如果是 **Fast (爽文)**：尽量少插入，除非逻辑断裂。保持紧凑。
           - 如果是 **Slow (慢热)**：在两个高潮事件之间，插入“日常/整顿/铺垫”节点。
           - 如果是 **Normal**：保持张弛有度。
           
        请返回一个列表，说明需要在哪些 ID 之后插入什么内容的过渡节点。
        如果没有需要插入的，返回空数组。
        
        **Output JSON Format Required:**
        { 
            "insertions": [ 
                { "insertAfterId": "string", "newSummary": "string" } 
            ] 
        }
    `;

    try {
        const text = await callOpenAI([
            { role: "system", content: settings.systemInstruction },
            { role: "user", content: prompt }
        ], settings, true);
        const res = JSON.parse(text);
        
        const validInsertions = (res.insertions || []).filter((i: any) => plotNodes.some(p => p.id === i.insertAfterId));
        return {
            insertAfterIds: validInsertions.map((i: any) => i.insertAfterId),
            summaries: validInsertions.map((i: any) => i.newSummary)
        };
    } catch (e) {
        return { insertAfterIds: [], summaries: [] };
    }
};

// --- 2. Logic Validation (JSON) ---

export const validateStoryLogic = async (params: AIRequestParams): Promise<LogicValidationResult> => {
    const { currentNode, globalContext, settings } = params;

    const prompt = `
      角色：资深小说主编。
      任务：逻辑一致性与事件密度审查。
      风格：${settings.novelStyle}
      
      【设定库】：${globalContext}
      【当前节点】：[${currentNode.type}] ${currentNode.title}
      【内容】：${currentNode.content.slice(0, 2000)}...
      
      请检查：
      1. **事件密度**：是否达到了“高密度”标准？(是否包含多个具体事件，还是在水字数？)。
      2. **行为逻辑**：主角的选择是否符合利益最大化或人设？
      3. **战力/设定**：是否与世界观冲突？

      **Output JSON Format Required:**
      { 
        "valid": boolean, 
        "score": number, 
        "issues": ["string"], 
        "suggestions": ["string"] 
      }
    `;

    try {
        const text = await callOpenAI([
            { role: "system", content: settings.systemInstruction },
            { role: "user", content: prompt }
        ], settings, true);
        
        return JSON.parse(text);
    } catch (error) {
        return { valid: false, score: 0, issues: ["API Error or Parse Error"], suggestions: [] };
    }
};

// New: Volume Information Span Check
export const validateVolumeSpan = async (
    node: NodeData, 
    targetPlotPoints: number, 
    settings: AppSettings
): Promise<{ sufficient: boolean, fixInstruction: string }> => {
    const prompt = `
        任务：【分卷大纲信息跨度审查】
        角色：网文结构分析师
        
        【待审查分卷】：${node.title}
        【大纲内容】：
        ${node.summary}
        
        【硬性要求】：
        该分卷将被拆分为 **${targetPlotPoints}** 个具体的剧情点（Plot Nodes）。
        通常 1 个剧情点对应 1 个具体的冲突或小事件。
        1 个“小副本/小高潮”通常消耗 3-5 个剧情点。
        因此，本卷大纲必须包含至少 **${Math.ceil(targetPlotPoints / 4)}~${Math.ceil(targetPlotPoints / 2)}** 个明确的小副本或大事件转折，才能支撑起 ${targetPlotPoints} 个节点的跨度。
        
        请判断：当前大纲的信息密度和跨度，是否足够拆分为 ${targetPlotPoints} 个不注水的剧情点？
        
        如果不足（Too Shallow/Short）：
        请构造一条【增量修复指令】，要求在保留现有剧情的基础上，**插入**新的中间事件、支线挑战或反派阻挠，以扩充大纲的体量。
        
        **Output JSON Format Required:**
        { 
          "sufficient": boolean, 
          "fixInstruction": "string" 
        }
        (fixInstruction should be empty if sufficient is true)
    `;

    try {
        const text = await callOpenAI([
            { role: "system", content: settings.systemInstruction },
            { role: "user", content: prompt }
        ], settings, true);
        return JSON.parse(text);
    } catch (e) {
        return { sufficient: true, fixInstruction: "" };
    }
};

export const batchValidateNodes = async (
    nodesToCheck: NodeData[],
    parent: NodeData,
    globalContext: string,
    settings: AppSettings
): Promise<{ hasConflicts: boolean; fixes: { id: string; instruction: string }[] }> => {
    
    // Determine strictness based on node type
    const nodeType = nodesToCheck[0]?.type;
    let strictRules = "";

    if (nodeType === NodeType.OUTLINE) {
        strictRules = `
        **[分卷大纲 (OUTLINE) 审查标准]**
        1. **事件广度**：每个分卷大纲必须包含大量发生的事件（Events），而不是单一场景的描写（Scene）。
        2. **地图跨越**：必须明确描述至少 1 次大的【地区/地图跨越】。
        `;
    } else if (nodeType === NodeType.PLOT) {
        strictRules = `
        **[剧情详纲 (PLOT) 审查标准]**
        1. **严禁写成正文**：如果内容包含大量对话、心理活动描写或环境白描，视为严重错误！
        2. **必须是流水账**：必须以“地点-人物-事件”的格式列出该节点发生的一系列动作。
        3. **事件列表**：检查是否像流水账一样列出了多个事件点。如果是单一场景的深度描写，视为违规。
        `;
    }

    const nodesText = nodesToCheck.map((n) => 
        `[ID: ${n.id}] [Type: ${n.type}]\nTITLE: ${n.title}\nCONTENT LENGTH: ${n.summary.length} chars\nCONTENT: ${n.summary}`
    ).join('\n----------------\n');

    const prompt = `
        角色：【逻辑精修师】
        任务：检查以下一组连续剧情节点的逻辑连贯性与质量。
        
        【全局设定】：${globalContext}
        【上级大纲 (Parent)】：${parent.title} - ${parent.summary}
        
        【待检查的节点链 (Batch)】：
        ${nodesText}
        
        ${strictRules}
        
        请进行审查，寻找以下问题：
        1. **逻辑断层**：前一个节点的结局是否自然引发下一个节点的开端？
        2. **格式错误 (重点)**：如果 PLOT 节点写成了小说正文（含对话/描写），必须报错，要求改为“流水账事件表”。
        
        **输出要求**：
        - 只有发现明显逻辑硬伤或关键缺失时才生成修复指令。
        - **Fix Instruction (指令)**：必须是针对性的修改建议。

        **Output JSON Format Required:**
        { 
          "hasConflicts": boolean, 
          "fixes": [ { "id": "string", "instruction": "string" } ] 
        }
    `;

    try {
         const text = await callOpenAI([
            { role: "system", content: settings.systemInstruction },
            { role: "user", content: prompt }
        ], settings, true);
        return JSON.parse(text);
    } catch(e) {
        return { hasConflicts: false, fixes: [] };
    }
};

export const applyLogicFixes = async (node: NodeData, instruction: string, settings: AppSettings): Promise<string> => {
    return await refineContent(node.summary, `【逻辑修复请求】\n针对问题：${instruction}\n请微调当前摘要以修复此逻辑问题。保留原有的核心事件，仅修改有问题的地方。`, settings);
};

// --- NEW: Smart Optimization Prompt Generator ---
export const analyzeAndGenerateFix = async (
    node: NodeData,
    context: string, // Combined Root + Parent + Prev
    resourcesContext: string, // NEW: Associated resources
    targetWordCount: number,
    userIdea: string,
    settings: AppSettings,
    isGlobalStart: boolean = false // NEW: Is this the first chapter of the book?
): Promise<string> => {
    
    let role = "主编";
    let focus = "";
    
    // Layer-aware focus
    switch (node.type) {
        case NodeType.ROOT:
            role = "世界观架构师";
            focus = `
            【Root层核心设定审计增量规则 (Strict)】：
            1. **增量原则**：除非用户要求，严禁删减原有的背景、力量体系、势力或人物设定。只能在原有基础上补充。

            `;
            focus = `
            【Root层审查重点 (Strict)】：
            1. **主线宏愿 (Main Arc)**：必须包含一条清晰、完整的故事主线链条（从开端到终局）。
               - 错误：只写了主角要变强。
               - 正确：主角要变强 -> 寻找X神器 -> 揭开Y秘密 -> 击败Z反派 -> 拯救世界。
            2. **力量体系**：等级划分是否清晰且具有吸引力？
            3. **核心爽点**：是否符合"${settings.novelStyle}"流派？
            4. **明确主线设计**：主线必须具备清晰的【时间线】（事件先后逻辑）和【区域空间轨迹】（主角从哪到哪，最后的事件在哪里）。
            5. **落幕高潮**：必须明确设计全书的【最后落幕事件】。这是全书的最高潮，标志着主线宏愿的完成，严禁含糊其辞。
            6. **【增量原则】**：除非用户明确要求删除，否则严禁删减原有的设定（如人物、势力、背景）。只能在原有基础上进行补充或修正。
            `;
            break;
        case NodeType.OUTLINE:
            role = "结构策划";
            focus = `
            【Outline层审查重点】：
            1. **地图流转**：本卷是否涉及地图/场景的切换？
            2. **大事件列表**：是否列出了多个具体的大事件，而非单一场景的描写？
            3. **起承转合**：结构是否完整？
            `;
            break;
        case NodeType.PLOT:
            role = "剧情编剧";
            focus = `
            【Plot层审查重点 (严格)】：
            1. **格式检查**：内容是否是“流水账”或“事件列表”？
               - 错误范例：“他缓缓走进房间，心中想到...” (这是正文，禁止！)
               - 正确范例：“1. 主角抵达客栈。2. 遭遇反派挑衅。3. 出手击杀反派。”
            2. **事件密度**：此节点必须包含3-5个具体的动作/冲突事件。
            3. **人物信息**：如果有新登场的【有名字的角色】，必须在此处列出。
            
            如果发现内容写得像小说正文（充满形容词、心理描写、对话），请**立刻给出Fail**，并要求重写为干练的事件流水账。
            `;
            break;
        case NodeType.CHAPTER:
            role = "金牌作家";
            let chapterSpecifics = "";
            if (isGlobalStart) {
                chapterSpecifics = `
                2. **黄金三章 (关键)**：这是全书的第一章！
                   - 必须快速抛出核心冲突或金手指。
                   - 必须制造强烈的期待感（钩子）。
                   - 节奏要快，切忌慢热。
                `;
            } else {
                chapterSpecifics = `
                2. **承上启下**：剧情逻辑必须与前文自然衔接。
                3. **人物一致性**：角色的言行必须符合设定。
                `;
            }

            focus = `
            【Chapter层审查重点】：
            1. **白描手法**：拒绝谜语人和空洞的心理描写，要写具体的动作和对话。
            ${chapterSpecifics}
            4. **字数要求**：必须达到 ${targetWordCount} 字以上。
            `;
            break;
    }

    const prompt = `
    角色：${role}
    任务：【节点质量审计与指令生成】
    
    【上下文信息】：
    ${context}

    【关联资源 (Resources)】：
    ${resourcesContext}

    【当前用户原始创意】：${userIdea}
    
    【待审计节点】：
    类型：${node.type}
    标题：${node.title}
    当前内容（Draft）：
    "${node.type === NodeType.CHAPTER ? node.content.slice(0, 1000) : node.summary}"
    ... (Length: ${(node.type === NodeType.CHAPTER ? node.content : node.summary).length} chars)
    
    ${focus}
    
    【判定逻辑】：
    请判断当前 Draft 是否满足高质量标准（字数 > ${targetWordCount} 且 包含上述重点要素）。
    
    如果 **不满足**，请生成一条 **专用修补/写作指令 (Instruction)**。
    这条指令将被发送给 AI 写手，要求其基于 Context 和 Draft 进行重写或扩写。
    
    **指令要求**：
    1. 必须具体指出缺什么（例如：“缺少主线目标”、“内容太像正文，改为大纲格式”）。
    2. 必须要求字数扩充到 ${targetWordCount} 以上。
    3. 语气要像主编给作者改稿一样犀利直接。
    4. 如果当前内容已经很完美，输出 "PASS"。
    
    **请直接输出指令内容 (String)，不要包含 JSON 格式，如果通过则输出 PASS。**
    `;

    return await callOpenAI([{ role: "user", content: prompt }], settings);
};

// --- 3. Node Expansion (The Core) ---

export const generateNodeExpansion = async (params: AIRequestParams): Promise<Partial<NodeData>[]> => {
  const { currentNode, parentContext, prevContext, nextContext, globalContext, settings, task, expansionConfig, milestoneConfig, structuralContext } = params;
  
  let targetType: NodeType;
  if (task === 'CONTINUE') {
      targetType = currentNode.type; 
  } else {
      switch(currentNode.type) {
          case NodeType.ROOT: targetType = NodeType.OUTLINE; break;
          case NodeType.OUTLINE: targetType = NodeType.PLOT; break;
          case NodeType.PLOT: targetType = NodeType.CHAPTER; break;
          default: throw new Error("该节点类型不支持向下细化");
      }
  }

  // Count to generate
  const count = (milestoneConfig?.generateCount || expansionConfig?.chapterCount || 1);
  const isSingleGeneration = count === 1;

  // --- Construct Position Context String ---
  let positionInfo = "";
  if (structuralContext) {
      if (structuralContext.volumeIndex) positionInfo += `当前进度：第 ${structuralContext.volumeIndex} 卷`;
      if (structuralContext.plotIndex) positionInfo += ` - 第 ${structuralContext.plotIndex} 剧情点`;
      if (structuralContext.chapterIndex) positionInfo += ` - 第 ${structuralContext.chapterIndex} 章`;
      if (structuralContext.globalChapterIndex) positionInfo += ` (全书第 ${structuralContext.globalChapterIndex} 章)`;
  }

  let taskPrompt = "";
  if (task === 'EXPAND') {
      // CASE 1: ROOT -> OUTLINE
      if (currentNode.type === NodeType.ROOT) {
           taskPrompt = `
             任务：【全书分卷规划】 (Volume Outline Generation)
             当前书名：${currentNode.title}
             【世界观与主线设定 (Bible)】：
             ${currentNode.content} 
             
             目标：推演接下来的 ${count} 个“分卷 (OUTLINE)”。
             
             **核心要求（事件广度）：**
             1. **宏观叙事**：每个分卷概括一整段大的剧情历程。
             2. **事件列表**：请列出该卷内发生的多个关键事件（Events）。不要去细致描写某个场景的心理活动。
             3. **地图流转**：明确指出本卷涉及的地图转换（例如：从新手村 -> 县城）。
             4. **禁止注水**：直接写干货剧情。不要写“主角心情很复杂”这种话，要写“主角杀死了敌人，夺取了宝物，引发了追杀”。
             5. **索引连续性**：如果上一个节点已经是第N卷，请接着生成第N+1卷。
             6. **区域跨度均衡**：确保分卷内容的结尾自然过渡到下一个大区域/副本的开启。不要让分卷在某个高潮中间突然截断，也不要留太长的尾巴。
             7.**首尾自然：要保证分卷的第一个和最后一个，符合一本书的卷的开始和结尾。
           `;
      } 
      // CASE 2: OUTLINE -> PLOT (UPDATED FOR REALM/COMBAT LOGIC + SPANNING MODE)
      else if (currentNode.type === NodeType.OUTLINE) {
           const isSpanningStrategy = milestoneConfig?.strategy === 'spanning';
           const strategyNote = isSpanningStrategy 
             ? `**关键生成策略 (Spanning)**: 请生成分布在【整个分卷时间线】上的 ${count} 个关键锚点 (Keyframes)。
                - 第1个节点：分卷的开篇/起因。
                - 中间节点：分卷中期的重大转折点/高潮前奏。
                - 最后一个节点：分卷的最终结局/高潮结束。
                - 这些节点**不需要**是连续的，它们是支撑起整个分卷骨架的柱子。`
             : `**常规生成策略 (Linear)**: 请从上一个节点接续，生成紧随其后的 ${count} 个连续剧情点。`;

           taskPrompt = `
             任务：【分卷剧情拆解 (Volume Breakdown)】
             
             当前层级：分卷大纲 (Outline) -> 剧情详纲 (Plot)
             当前分卷：${currentNode.title}
             分卷核心梗概：
             "${currentNode.content}"
             
             ${prevContext ? `已生成的上一个剧情点：${prevContext.title} (${prevContext.summary})` : '当前尚未生成任何剧情点，请从分卷的开篇开始。'}
             
             目标：**基于分卷梗概**，将接下来的剧情拆解为 ${count} 个具体的“剧情事件点 (PLOT)”。
             ${strategyNote}
             
             **核心规则（重要 - 必须执行）：**
             1. **【战力与境界校验】(CRITICAL)**：
                - 每个剧情点 summary 必须明确注明主角**当前的境界/等级** (例如：[练气三层] 或 [S级初期])。
                - 如果剧情涉及战斗，必须符合逻辑：
                  * 严禁在无理由的情况下跨大境界杀敌。
                  * 如果需要跨阶战斗，必须在剧情中说明依靠了什么**具体资源、金手指或外挂** (例如：消耗了X符箓，使用了Y神器)。
                - 如果剧情包含境界突破，必须明确写出：“主角在此处突破至[新境界]”。
             2. **【禁止续写，必须拆解】**：你的任务不是写分卷大纲结局之后发生了什么，而是**把分卷大纲里的内容切分成小块**。
                - 如果分卷大纲是“主角攻打魔教”，那么这 ${count} 个Plot必须涵盖“集结人马 -> 攻破山门 -> 苦战护法 -> 决战教主”的全过程。
                - 必须覆盖分卷的【起、承、转、合】。
             3. **颗粒度要求**：每个 PLOT 节点代表一个具体的【场景/关卡】（例如：潜入藏经阁、密林遭遇战）。
             4. **格式要求（流水账）**：在 summary 中，必须列出该场景内发生的 3-5 个具体动作（Action Beats）。
                - 不要写心理描写！不要写对话！
                - 格式范例：
                  * [境界：练气七层] 主角到达[地点]。
                  * 遭遇[强敌:筑基期妖兽]。
                  * [金手指] 开启狂暴模式，勉强击退妖兽。
                  * 获得[物品]。
             5. **人物完备性**：如果在该剧情中会出现任何【有名字】的角色（包括配角、反派），必须在此处明确列出。后续正文写作严禁凭空增加有名字的新人物（路人甲乙除外）。
           `;
      } 
      // CASE 3: PLOT -> CHAPTER (UPDATED FOR REALM CONSISTENCY)
      else if (currentNode.type === NodeType.PLOT) {
          const words = expansionConfig?.wordCount || '3000';
          
          taskPrompt = `
            任务：【章节拆分】(Strict Partitioning)
            当前剧情单元：${currentNode.title}
            ${positionInfo}
            【剧情详纲 (Source Events)】：
            ${currentNode.content}
            
            目标：将上述【剧情详纲】中的事件，**无遗漏、无新增**地分配到接下来的 ${count} 个“章节 (CHAPTER)”中。
            
            **核心要求：**
            1. **【境界一致性】**：章节细纲必须严格遵守详纲中设定的主角境界。如果详纲提到“突破”，章节中必须包含突破过程。
            2. **总量守恒**：这 ${count} 章的所有事件加起来，必须严格等于【剧情详纲】的内容。
               - 如果详纲有6个事件，分2章，则每章分3个事件。
               - **严禁**新增详纲中不存在的关键事件。
               - **严禁**新增详纲中未提及的有名字人物（路人甲/店小二等无名氏除外）。
            3. **细纲设计**：每个 Chapter 的 Summary 必须是详纲中对应部分的子集。
            4. **Context Aware**：请注意当前是全书第 ${structuralContext?.globalChapterIndex || '?'} 章。
          `;
      }
  } else if (task === 'CONTINUE') {
      if (nextContext) {
           taskPrompt = `
             任务：【插入过渡剧情 (Infill) - 剧情点生成】
             
             前置节点 (Start)：${currentNode.title}
             后置节点 (End)：${nextContext.title}
             
             目标：请生成 ${count} 个中间剧情节点 (PLOT)，填补上述两个节点之间的剧情空白。
             确保剧情从前置节点的结局自然过渡到后置节点的开端，逻辑连贯，解释清楚中间发生了什么。
             
             **核心要求（与标准剧情点一致）：**
             1. **【战力与境界校验】**：每个过渡节点 summary 必须明确注明主角**当前的境界/等级**。如果涉及战斗，严禁无理由跨阶杀敌，必须说明使用的资源/金手指。
             2. **【格式要求】**：必须是“流水账”或“事件列表”格式。列出该场景内发生的 3-5 个具体动作 (Action Beats)。**不要写心理描写！不要写对话！**
             3. **【逻辑衔接】**：
                - 第1个生成的节点必须紧接前置节点。
                - 最后一个生成的节点必须完美引出后置节点的开局。
                - 中间的节点负责铺垫、转折或展示途中的遭遇。
            4. **人物完备性**：如果在该剧情中会出现任何【有名字】的角色（包括配角、反派），必须在此处明确列出。后续正文写作严禁凭空增加有名字的新人物（路人甲乙除外）。
           `;
      } else {
           taskPrompt = `任务：【续写后续剧情】基于 ${currentNode.title} 的结局，推演下 ${count} 个逻辑紧密的剧情单元。`;
      }
  }

  const prompt = `
    ${taskPrompt}
    
    【世界观/全局上下文】：${globalContext}
    【上级脉络 (Parent)】：${parentContext?.title || 'ROOT'} - ${parentContext?.summary || ''}
    【前情提要 (Previous)】：${prevContext?.title || '无'} - ${prevContext?.summary || ''}

    **Output JSON Format Required:**
    [ { "title": "string", "summary": "string" }, ... ]
    
    IMPORTANT: Return a valid JSON Array with exactly ${count} items.
    Ensure "summary" focuses on WHAT HAPPENS (Event Breadth), not how it feels.
  `;

  try {
    const text = await callOpenAI([
        { role: "system", content: settings.systemInstruction },
        { role: "user", content: prompt }
    ], settings, true);

    const result = JSON.parse(text);
    // Handle wrapped responses like { "items": [...] } or direct array [...]
    const arrayData = Array.isArray(result) ? result : (result.items || result.nodes || []);
    
    return arrayData.map((item: any) => ({
        title: item.title,
        summary: item.summary,
        type: targetType, 
        content: item.summary 
    }));
  } catch (error) {
    console.error("Expansion Error:", error);
    return [];
  }
};

// --- 4. Writing & Refining ---

export const generateChapterContent = async (params: AIRequestParams): Promise<string> => {
    const { currentNode, parentContext, prevContext, globalContext, settings, structuralContext } = params;
    
    const prevContentEnding = prevContext?.content ? prevContext.content.slice(-500) : "";
    const notes = currentNode.content ? `【本章事件大纲】：${currentNode.content}` : "";
    
    // Construct Opening Context
    let openingInstruction = "";
    if (structuralContext?.globalChapterIndex === 1) {
        openingInstruction = "**特别注意：这是全书的第一章（黄金三章之首）。请务必精心设计开篇，快速抛出主角身份、金手指暗示和第一个核心冲突。切忌平淡。**";
    }

    const prompt = `
      任务：撰写正文 (高密度网文模式)。
      流派：${settings.novelStyle}
      当前位置：第 ${structuralContext?.volumeIndex || 1} 卷 - 第 ${structuralContext?.chapterIndex || 1} 章 (全书第 ${structuralContext?.globalChapterIndex || 1} 章)
      
      【本章标题】：${currentNode.title}
      【本章摘要】：${currentNode.summary}
      ${notes}
      
      【所属剧情单元/详纲】：${parentContext?.title || '未知'} (详纲: ${parentContext?.content || ''})
      
      【上章结尾（必须无缝接龙）】：
      "...${prevContentEnding}"
      
      【关联设定】：${globalContext}

      ${openingInstruction}

      **绝对写作禁令 (严格执行，否则任务失败)：**
      1. **严禁比喻与修辞**：禁止使用“像...一样”、“宛如”、“仿佛”等比喻句。使用【白描】手法，直接描写动作和神态。
      2. **对话驱动**：全章 60% 以上篇幅必须是对话。通过对话推动剧情。
      3. **极简环境描写**：全章最多只能出现 1 句环境描写，且必须一笔带过。
      4. **【最高优先级】禁止预示性结尾**：严禁在结尾写“他不知道的是...”、“这仅仅是开始...”等。
      5. **【信息封闭原则】**：严格按照【本章摘要】写。
         - 禁止引入摘要中未出现的【有名字的新人物】（仅允许出现“路人A”、“黑衣人”等无名代称）。
         - 禁止引入摘要中未提及的【新地点】或【新设定】。
         - 你的任务是“扩写”摘要中的事件，而不是“创作”新剧情。
      
      输出要求：
      - Markdown 格式。
      - 直接开始正文，不需要写标题。
      - 尽量写长，目标 2000 字以上。
    `;

    return await callOpenAI([
        { role: "system", content: settings.systemInstruction },
        { role: "user", content: prompt }
    ], settings);
};

export const validateEndingStyle = async (text: string, settings: AppSettings): Promise<{ isValid: boolean, fixInstruction: string }> => {
    if (!text || text.length < 200) return { isValid: true, fixInstruction: "" };
    
    const prompt = `
        任务：检查小说章节结尾是否违规（防出戏检查）。
        【结尾片段】：
        "...${text.slice(-800)}"
        
        **严禁出现这类描述（命中任意一条即为 Invalid）**：
        1. **预示未来**：出现了“命运的齿轮”、“他不知道未来会发生什么”、“这仅仅是个开始”、“风暴即将来临”、“他意识到***即将到来”等上帝视角的预告。
        2. **总结陈词**：出现了对本章内容的总结、感悟或升华（例如“经过这一战，他成长了...”）。
        3. **非动作/对话结尾**：结尾落在心理活动或环境描写上，而不是具体的【动作】、【对话】或【突发事件】。

        **Output JSON Format Required:**
        { "isValid": boolean, "fixInstruction": "string" }
        (isValid: true means ok, false means violation)
    `;

    try {
        const res = await callOpenAI([{ role: "user", content: prompt }], settings, true);
        return JSON.parse(res);
    } catch (e) {
        return { isValid: true, fixInstruction: "" };
    }
};

export const refineContent = async (text: string, instruction: string, settings: AppSettings, context: string = ""): Promise<string> => {
    const prompt = `
        任务：【内容微调与润色】
        
        ${context ? `【上下文信息】：\n${context}\n` : ''}

        原文内容：
        "${text}"

        用户指令：${instruction}
        小说风格：${settings.novelStyle}

        **STRICT OUTPUT RULE:**
        1. You must ONLY return the rewritten content/story text.
        2. Do NOT output "Here is the revised text:", "Optimized version:", "Sure", or "Okay".
        3. Do NOT wrap the output in markdown code blocks (e.g., \`\`\`markdown).
        4. If the user asks to preserve content, ensure the output includes the preserved parts.
    `;
    return await callOpenAI([
        { role: "system", content: settings.systemInstruction },
        { role: "user", content: prompt }
    ], settings);
};

export const generateRefinementPrompt = async (
    nodeType: NodeType,
    contextSummary: string,
    userIntent: string,
    settings: AppSettings
): Promise<string> => {
    let roleDescription = "";
    switch(nodeType) {
        case NodeType.ROOT: roleDescription = "资深世界观架构师"; break;
        case NodeType.OUTLINE: roleDescription = "副本关卡策划"; break;
        case NodeType.PLOT: roleDescription = "金牌剧情编剧"; break;
        case NodeType.CHAPTER: roleDescription = "起点/晋江金牌大神作家"; break;
        default: roleDescription = "资深编辑";
    }

    let specificGuidelines = "";
    if (nodeType === NodeType.PLOT) {
        specificGuidelines = `
        针对【剧情详纲 (PLOT)】层级的特殊要求：
        1. 必须侧重于【事件广度】。
        2. 不要进行单一场景的深度描写（Scene），要列出多个事件（Events）。
        3. 增加“期待感”和“爽点”的设计，明确下一个冲突是什么。
        4. **格式必须是流水账**：地点-人物-行为。不要写正文。
        `;
    } else if (nodeType === NodeType.OUTLINE) {
        specificGuidelines = `
        针对【分卷大纲 (OUTLINE)】层级的特殊要求：
        1. 必须是宏观的事件列表。
        2. 明确地图流转。
        3. 确保整卷的起承转合逻辑。
        `;
    }
    
    // ROOT special handling
    if (nodeType === NodeType.ROOT) {
         specificGuidelines = `
         针对【世界观 (ROOT)】层级的特殊要求：
         1. **最重要的规则：完全保留**原有的世界背景、等级体系、势力和人物设定。禁止删除或覆盖。
         2. 任务是**丰富主线剧情 (Main Arc)**。请在原有内容的基础上，扩展故事的发展脉络。
         3. 不要撰写具体的分卷细节（例如“第一卷：xxx”），而是要写全局的故事走向概梗。
         4. 必须保留 Markdown 格式。
         `;
    }

    const prompt = `
        任务：你是${roleDescription}。请根据用户的【模糊意图】，将其转化为一条**结构化、高执行力**的AI Prompt。
        
        【当前场景】：
        - 节点层级：${nodeType}
        - 小说流派：${settings.novelStyle}
        - 内容摘要：${contextSummary.slice(0, 500)}...
        
        【用户模糊意图】："${userIntent}"
        
        ${specificGuidelines}

        【生成要求】：
        请输出一段完整的提示词（Prompt），包含以下结构：
        [角色设定]: 指定AI扮演的角色。
        [任务目标]: 明确要改什么。
        [风格要求]: 结合流派。
        [修改规则]: 列出3条具体的修改准则。
        [具体实例]: 列出符合用户要求的一段例子。
        
        **特别注意**：生成的 Prompt 必须明确告诉 AI 在执行修改时，**基于原文进行修改**，而不是凭空重写（除非用户要求重写）。
        请直接输出生成的Prompt内容，不要包含其他解释。
    `;
    return await callOpenAI([{ role: "user", content: prompt }], settings);
};

// --- 5. Background Tasks ---

export const extractLoreUpdates = async (chapterText: string, relevantNodes: NodeData[], settings: AppSettings): Promise<LoreUpdateSuggestion[]> => {
    if (relevantNodes.length === 0) return [];
    
    const nodesInfo = relevantNodes.map(n => `ID: ${n.id} | Name: ${n.title} | Current Summary: ${n.summary}`).join('\n---\n');
    
    const prompt = `
        任务：【设定增量同步】
        阅读以下最新生成的章节正文，检查其中是否包含了关于关联角色/物品的 *新信息*（如新学会的招式、性格变化、受的伤、获得的道具属性）。
        
        【章节正文】：
        ${chapterText.slice(0, 5000)}...

        【关联设定库】：
        ${nodesInfo}

        要求：
        1. 只有当正文里出现了和当前设定 *不同或新增* 的信息时才提取。
        2. 生成新的 Summary（必须包含旧信息 + 新增信息，整合后的版本）。
        3. 返回 JSON 数组。
        
        **Output JSON Format Required:**
        [ { "targetId": "string", "newSummary": "string", "reason": "string" } ]
    `;

    try {
        const text = await callOpenAI([{ role: "user", content: prompt }], settings, true);
        const res = JSON.parse(text);
        return Array.isArray(res) ? res : (res.updates || []);
    } catch (error) {
        return [];
    }
};

export const autoExtractWorldInfo = async (
    textToAnalyze: string,
    existingResources: NodeData[],
    settings: AppSettings
): Promise<WorldStateAnalysis> => {
    if (!textToAnalyze || textToAnalyze.length < 50) return { newResources: [], updates: [], mentionedIds: [] };

    const resourceContext = existingResources.map(r => 
        `[ID:${r.id}] Type:${r.type} Title:${r.title} Summary:${r.summary.slice(0, 100)}...`
    ).join('\n');

    const prompt = `
        角色：【世界观管理员】
        任务：后台静默分析剧情文本，维护世界观数据库。
        
        【新剧情文本】：
        "${textToAnalyze.slice(0, 5000)}..."
        
        【现有资源库】：
        ${resourceContext}
        
        目标：
        1. **识别新资源**：文本中是否登场了 *全新* 且 *重要* 的实体（CHARACTER/ITEM/LOCATION/FACTION）？如果是，请建立档案。忽略路人甲。
        2. **更新旧资源**：文本中是否包含现有资源的 *关键状态变更*（如受伤、升级、获得宝物、灭亡）？如果是，请更新其Summary。
        3. **关联分析**：列出文本中提到的所有现有资源的ID。
        
        注意：
        - 对于【删除/Delete】，请非常谨慎。**只要剧情提到该物体就不允许删除。** 建议只做 Update 一些特殊状态，可标注其“在第*卷第*剧情点已死亡/毁坏”。
        - 优先增加（New）资源，尽量不要修改（Update）除非有重大状态变更。
        - LOCATION（地点）例子：新地图、新城市。
        - FACTION（势力）例子：新宗门、新公会。
        
        **Output JSON Format Required:**
        {
          "newResources": [ { "type": "CHARACTER"|"ITEM"|"LOCATION"|"FACTION", "title": "...", "summary": "..." } ],
          "updates": [ { "id": "...", "newSummary": "...", "changeLog": "..." } ],
          "mentionedIds": [ "..." ]
        }
    `;

    try {
        const text = await callOpenAI([{ role: "system", content: "You are a World Database Admin." }, { role: "user", content: prompt }], settings, true);
        return JSON.parse(text);
    } catch (e) {
        return { newResources: [], updates: [], mentionedIds: [] };
    }
};

export const associateRelevantResources = async (
    nodeContent: string,
    availableResources: NodeData[],
    settings: AppSettings
): Promise<string[]> => {
    if (availableResources.length === 0) return [];

    const resourceList = availableResources.map(r => `[ID: ${r.id}] ${r.title}`).join('\n');
    
    const prompt = `
        任务：【资源关联筛选】
        
        【当前剧情大纲】：
        "${nodeContent.slice(0, 3000)}"
        
        【可用资源池 (从父级继承)】：
        ${resourceList}
        
        目标：从资源池中选出**当前剧情中实际出现或高度相关**的资源ID。
        
        规则：
        1. 如果剧情提到了某个角色、物品或地点，必须选中。
        2. 如果剧情发生在某势力范围内，选中该势力。
        3. 不要选中无关的资源。
        
        **Output JSON Format Required:**
        { "selectedIds": ["string", "string"] }
    `;

    try {
        const text = await callOpenAI([{ role: "user", content: prompt }], settings, true);
        const res = JSON.parse(text);
        return res.selectedIds || [];
    } catch (e) {
        return [];
    }
};
