
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

        const baseUrl = settings.baseUrl ? settings.baseUrl.replace(/\/$/, '') : 'https://api.openai.com/v1';
        const url = `${baseUrl}/chat/completions`;
        
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`
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
                         console.warn(`[API] 429 Rate Limit. Retrying in ${waitTime}ms...`);
                         await delay(waitTime);
                         continue;
                    }
                    throw new Error(`API Error ${response.status}: ${errText}`);
                }

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || "";
                return content;

            } catch (error: any) {
                console.error(`Attempt ${i+1} failed:`, error);
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
        - 字数控制在 500-800 字之间。
    `;

    const messages = [
        { role: "system", content: settings.systemInstruction },
        { role: "user", content: prompt }
    ];

    try {
        return await callOpenAI(messages, settings);
    } catch (e) {
        console.error("Init Worldview Error", e);
        return "世界观生成失败，请检查 API Key 或 BaseURL 配置。";
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
        3. 强调【地图副本推进】的结构：每卷包含2-3个大副本，每个副本包含多个区域。
        4. 强调【高密度事件】：主角的选择->行动->后果，每章至少3个事件。
        5. 保持指令清晰，直接返回优化后的提示词内容，不要包含其他解释。
    `;

    return await callOpenAI([{ role: "user", content: prompt }], settings);
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
      【内容】：${currentNode.content.slice(0, 1500)}...
      
      请检查：
      1. **事件密度**：是否达到了“高密度”标准？是否存在大量无效对话或注水？(一章应包含至少3个有效事件)。
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
        **[分卷大纲 (OUTLINE) 严格审查标准]**
        1. **字数达标**：每个 Outline 的 Summary 必须超过 2000 字（包含详尽的地图流转和事件推演）。内容过短视为【严重违规】。
        2. **地图跨越**：必须明确描述至少 1 次大的【地区/地图跨越】（如从新手村到主城）。
        3. **格式规范**：严禁出现子标题（如 "1. 起因"），必须是连贯的叙事文本。
        `;
    } else if (nodeType === NodeType.PLOT) {
        strictRules = `
        **[剧情详纲 (PLOT) 严格审查标准]**
        1. **字数达标**：每个 Plot 的 Summary 必须超过 2000 字。
        2. **信息完备**：必须包含该剧情段落内出现的所有【新人物】、【新物品】、【新能力】、【新地图】的具体设定。不能只写“主角获得了一个宝物”，必须写明“主角获得了【青冥剑】，属性是...”。
        3. **事件密度**：必须包含支撑 3-5 章正文的高密度事件量。
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
        
        请进行严格审查，寻找以下问题：
        1. **逻辑断层**：前一个节点的结局是否自然引发下一个节点的开端？
        2. **内容质量**：是否满足上述严格审查标准？
           - 如果字数严重不足，指令应为：“扩充内容至2000字以上，补充XXX细节”。
           - 如果缺少地图跨越，指令应为：“增加地图转换情节”。
        3. **设定冲突**：是否与上级大纲或全局设定矛盾？
        
        **输出要求**：
        - 只有发现明显问题时才生成修复指令。
        - **Fix Instruction (指令)**：必须是针对性的修改建议。
        - 如果该节点问题不大，不需要修复，则不要列在返回列表中。

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
    return await refineContent(node.summary, `【逻辑修复请求】\n针对问题：${instruction}\n请微调当前摘要以修复此逻辑问题。注意：如果是字数不足，请务必大幅扩充细节。保留原有的核心事件，仅修改有问题的地方。如果是删除助手语，请直接输出纯净的内容。`, settings);
};

// --- 3. Node Expansion (The Core) ---

export const generateNodeExpansion = async (params: AIRequestParams): Promise<Partial<NodeData>[]> => {
  const { currentNode, parentContext, prevContext, nextContext, globalContext, settings, task, expansionConfig, milestoneConfig, structuralContext } = params;
  
  // Strict Logic for Task Type
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

  // --- Construct Position Context String ---
  let positionInfo = "";
  if (structuralContext) {
      if (structuralContext.volumeIndex) positionInfo += `当前进度：第 ${structuralContext.volumeIndex} 卷`;
      if (structuralContext.plotIndex) positionInfo += ` - 第 ${structuralContext.plotIndex} 剧情点`;
      if (structuralContext.chapterIndex) positionInfo += ` - 第 ${structuralContext.chapterIndex} 章`;
      if (structuralContext.globalChapterIndex) positionInfo += ` (全书第 ${structuralContext.globalChapterIndex} 章)`;
      
      // Special Opening Handling
      if (structuralContext.globalChapterIndex === 1) {
          positionInfo += "\n【特殊指令】：这是全书的开篇第一章（黄金开篇）。必须交代主角背景、核心金手指，并制造第一个强冲突（退婚/被羞辱/危机临头）。吸引读者留存。";
      }
  }

  let taskPrompt = "";
  if (task === 'EXPAND') {
      // CASE 1: ROOT -> OUTLINE
      if (currentNode.type === NodeType.ROOT) {
           const count = milestoneConfig?.generateCount || 3;
           taskPrompt = `
             任务：【全书分卷规划】 (Volume Outline Generation)
             当前书名：${currentNode.title}
             【世界观与主线设定 (Bible)】：
             ${currentNode.content} 
             
             目标：依据世界观中的【主线宏愿】，推演小说的前 ${count} 个“分卷 (OUTLINE)”。
             
             **核心硬指标（必须严格执行）：**
             1. **字数要求**：每个 Summary 必须 **超过 2000 字**。这是一份详尽的剧情推演，不是简介！
             2. **地图流转**：每一卷必须包含明确的【地区跨越】（例如：从新手村 -> 县城 -> 宗门）。
             3. **格式规范**：Title 必须是 "第一卷：[卷名]" 的格式。Summary 内部 **严禁使用 Markdown 标题 (##)**，必须是连贯的段落叙述。
             4. **叙事结构**：必须包含完整的 起（卷首危机）-> 承（换地图/升级）-> 转（遭遇宿敌/发现阴谋）-> 合（卷末大战/伏笔）。
           `;
      } 
      // CASE 2: OUTLINE -> PLOT
      else if (currentNode.type === NodeType.OUTLINE) {
           const total = milestoneConfig?.totalPoints || 10;
           const count = milestoneConfig?.generateCount || 5;
           
           taskPrompt = `
             任务：【细化剧情详纲 (Detailed Plot Outline)】
             当前分卷：${currentNode.title}
             ${positionInfo}
             【分卷大纲】：
             ${currentNode.content}
             
             本卷总计约 ${total} 个剧情点。请为我生成接下来的 ${count} 个关键【剧情详纲节点 (PLOT)】。
             
             **核心硬指标（必须严格执行）：**
             1. **字数要求**：每个 PLOT 的 Summary 必须 **超过 2000 字**。
             2. **信息完备性**：必须包含该阶段所有【新人物】、【新物品】、【新功法】、【新地图】的具体设定。不要只说“获得了宝物”，要写出“获得了[玄天镜]，功能是照妖”。
             3. **事件支撑**：每个 PLOT 节点必须包含能支撑 3-5 章正文的高密度事件量。
             4. **格式**：Summary 必须采用【节拍器】格式撰写，包含：【核心冲突】、【关键交互】、【详细事件推演】。
           `;
      } 
      // CASE 3: PLOT -> CHAPTER
      else if (currentNode.type === NodeType.PLOT) {
          const count = expansionConfig?.chapterCount || 3;
          const words = expansionConfig?.wordCount || '3000';
          
          taskPrompt = `
            任务：【章节拆分与事件排布】
            当前剧情单元：${currentNode.title}
            ${positionInfo}
            【剧情详纲】：
            ${currentNode.content}
            
            **核心前提：**
            该 PLOT 节点是一个剧情单元，现在需要将其落实为具体的章节 (CHAPTER)。
            
            目标：将上述详纲拆分为 ${count} 个具体的“章节”。
            
            **核心要求（三事件原则）：**
            1. **细纲字数**：每个 Chapter 的 Summary (细纲) 必须 **超过 500 字**，信息量必须充足。
            2. **事件密度**：每一章必须包含至少 3 个完整事件。
            3. **逻辑连贯**：上一章的结尾必须自然衔接下一章的开头。
            4. **Context Aware**：请注意当前是全书第 ${structuralContext?.globalChapterIndex || '?'} 章，请根据进度调整节奏。
            
            每章预期正文字数：${words} 字。
          `;
      }
  } else if (task === 'CONTINUE') {
      taskPrompt = nextContext 
        ? `任务：【插入过渡剧情】在 ${currentNode.title} 和 ${nextContext.title} 之间插入一个过渡节点。必须解决两个事件点之间的逻辑断层。`
        : `任务：【续写后续剧情】基于 ${currentNode.title} 的结局，推演下一个逻辑紧密的剧情单元。需包含新的危机或目标。`;
  }

  const prompt = `
    ${taskPrompt}
    
    【世界观/全局上下文】：${globalContext}
    【上级脉络 (Parent)】：${parentContext?.title || 'ROOT'} - ${parentContext?.summary || ''}
    【前情提要 (Previous)】：${prevContext?.title || '无'} - ${prevContext?.summary || ''}

    **Output JSON Format Required:**
    [ { "title": "string", "summary": "string" } ]
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
      5. **【最高优先级】字数要求**：必须输出 **2000字以上** 的正文。如果不达标，将被视为任务失败。
      
      输出要求：
      - Markdown 格式。
      - 直接开始正文，不需要写标题。
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
        
        **违规判定标准（命中任意一条即为 Invalid）**：
        1. **预示未来**：出现了“命运的齿轮”、“他不知道未来会发生什么”、“这仅仅是个开始”、“风暴即将来临”等上帝视角的预告。
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

export const refineContent = async (text: string, instruction: string, settings: AppSettings): Promise<string> => {
    const prompt = `
        任务：【内容微调与润色】
        
        原文内容：
        "${text}"

        用户指令：${instruction}
        小说风格：${settings.novelStyle}

        **STRICT OUTPUT RULE:**
        1. You must ONLY return the rewritten content/story text.
        2. Do NOT output "Here is the revised text:", "Optimized version:", "Sure", or "Okay".
        3. Do NOT wrap the output in markdown code blocks (e.g., \`\`\`markdown).
        4. Just output the story content directly.
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
        1. 所有的修改必须围绕【冲突】展开。不要增加无关的环境描写。
        2. 确保【事件链】的紧凑性（起因->行动->结果）。
        3. 增加“期待感”和“爽点”的设计。
        `;
    }

    const prompt = `
        任务：你是${roleDescription}。请根据用户的【模糊意图】，将其转化为一条**结构化、高执行力**的AI Prompt。
        
        【当前场景】：
        - 节点层级：${nodeType}
        - 小说流派：${settings.novelStyle}
        - 内容摘要：${contextSummary.slice(0, 200)}...
        
        【用户模糊意图】："${userIntent}"
        
        ${specificGuidelines}

        【生成要求】：
        请输出一段完整的提示词（Prompt），包含以下结构：
        [角色设定]: 指定AI扮演的角色。
        [任务目标]: 明确要改什么。
        [风格要求]: 结合流派。
        [修改规则]: 列出3条具体的修改准则。
        [具体实例]: 列出符合用户要求的一段例子。
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
        - 对于【删除/Delete】，请非常谨慎。除非明确提到“彻底毁灭”、“灵魂消散”等，否则不要建议删除。目前阶段建议只做 Update 标注其“已死亡/毁坏”。
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
