import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import { AIRequestParams, NodeType, NodeData, LogicValidationResult, LoreUpdateSuggestion, AppSettings, WorldStateAnalysis } from '../types';

// Helper: Delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Retry Wrapper
const callAIWithRetry = async <T>(fn: () => Promise<T>, retries = 3): Promise<T> => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error: any) {
            const msg = error?.message || '';
            // Check for 429 or 503 (Service Unavailable)
            if (msg.includes('429') || msg.includes('503') || error?.status === 429 || error?.code === 429) {
                const waitTime = 2000 * (2 ** i); // 2s, 4s, 8s
                console.warn(`[Gemini API] Rate limit hit. Retrying in ${waitTime/1000}s...`);
                await delay(waitTime);
                continue;
            }
            throw error;
        }
    }
    throw new Error("API Request Failed after max retries. Please check quota.");
};

// Helper: Prioritize User Key -> Env Key
const createAI = (settings: AppSettings) => {
    const key = settings.apiKey || process.env.API_KEY;
    if (!key) throw new Error("缺少 API Key，请在设置中配置");
    
    // Construct options object correctly
    const options: any = { apiKey: key };
    if (settings.baseUrl) {
        options.baseUrl = settings.baseUrl;
    }

    return new GoogleGenAI(options);
};

// Helper: Get Thinking Config if supported model
const getThinkingConfig = (settings: AppSettings, isComplexTask: boolean = false) => {
    // Only Gemini 2.5 series supports thinking config
    if (settings.modelName.includes('2.5') && settings.thinkingBudget > 0 && isComplexTask) {
        return {
            thinkingConfig: {
                thinkingBudget: settings.thinkingBudget
            }
        };
    }
    return {};
};

// --- NEW: Generate Initial Worldview ---
export const generateInitialWorldview = async (title: string, settings: AppSettings): Promise<string> => {
    const ai = createAI(settings);
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

    try {
        const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
            config: {
                systemInstruction: settings.systemInstruction, 
                temperature: 0.85,
                // Worldview creation benefits heavily from thinking
                ...getThinkingConfig(settings, true) 
            }
        }));
        return response.text || "世界观生成失败，请手动输入...";
    } catch (e) {
        console.error("Init Worldview Error", e);
        return "世界观初始化遇到问题，请检查 API 配置或重试。";
    }
};

// --- NEW: System Instruction Optimization ---
export const optimizeSystemInstruction = async (title: string, style: string, currentInstruction: string, settings: AppSettings): Promise<string> => {
    const ai = createAI(settings);
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

    try {
        const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
        }));
        return response.text || currentInstruction;
    } catch (e) {
        console.error("Optimize Prompt Error", e);
        return currentInstruction;
    }
};

// 1. Logic Validation
export const validateStoryLogic = async (params: AIRequestParams): Promise<LogicValidationResult> => {
    const { currentNode, parentContext, prevContext, nextContext, globalContext, settings } = params;
    const ai = createAI(settings);

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

      返回 JSON: { valid: boolean, score: number, issues: string[], suggestions: string[] }
    `;

    try {
        const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        valid: { type: Type.BOOLEAN },
                        score: { type: Type.INTEGER },
                        issues: { type: Type.ARRAY, items: { type: Type.STRING } },
                        suggestions: { type: Type.ARRAY, items: { type: Type.STRING } }
                    },
                    required: ['valid', 'score', 'issues', 'suggestions']
                },
                ...getThinkingConfig(settings, true)
            }
        }));
        if (response.text) return JSON.parse(response.text);
        throw new Error("Empty response");
    } catch (error) {
        return { valid: false, score: 0, issues: ["API Error"], suggestions: [] };
    }
};

// --- NEW: Batch Logic Validation (Context Aware & Targeted) ---
export const batchValidateNodes = async (
    nodesToCheck: NodeData[],
    parent: NodeData,
    globalContext: string,
    settings: AppSettings
): Promise<{ hasConflicts: boolean; fixes: { id: string; instruction: string }[] }> => {
    const ai = createAI(settings);
    
    // Include both Title and Summary/Content for analysis
    const nodesText = nodesToCheck.map((n, i) => 
        `[ID: ${n.id}] [Type: ${n.type}]\nTITLE: ${n.title}\nCONTENT: ${n.summary}`
    ).join('\n----------------\n');

    const prompt = `
        角色：【逻辑精修师】
        任务：检查以下一组连续剧情节点的逻辑连贯性与质量。
        
        【全局设定】：${globalContext}
        【上级大纲 (Parent)】：${parent.title} - ${parent.summary}
        
        【待检查的节点链 (Batch)】：
        ${nodesText}
        
        请进行严格审查，寻找以下问题：
        1. **逻辑断层**：前一个节点的结局是否自然引发下一个节点的开端？
        2. **内容质量**：
           - **[OUTLINE 层级]**：内容是否足够丰富？是否包含了完整的【地图流转】（从A地去B地）和【核心冲突】？如果只是简短的一句话（如“主角去修炼”），视为【内容贫乏】，必须修复。
           - **[Meta 文本检测]**：内容是否包含了“好的，这是大纲”、“以下是生成的剧情”等 AI 助手语？必须删除。
           - **[OUTLINE 格式]**：标题必须是“第一卷：xxx”格式。
        3. **设定冲突**：是否与上级大纲或全局设定矛盾？
        
        **输出要求**：
        - 只有发现明显问题时才生成修复指令。
        - **Fix Instruction (指令)**：必须是针对性的修改建议。
          - 针对 Meta 文本：指令应为“删除助手回复语，只保留故事大纲”。
          - 针对内容贫乏：指令应为“扩充本卷大纲，补充具体的地图路线、反派名称和高潮战役的细节，字数扩充至 300 字以上”。
        - 如果该节点问题不大，不需要修复，则不要列在返回列表中。

        返回 JSON: { hasConflicts: boolean, fixes: [{ id: string, instruction: string }] }
    `;

    try {
         const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        hasConflicts: { type: Type.BOOLEAN },
                        fixes: { 
                            type: Type.ARRAY, 
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    id: { type: Type.STRING },
                                    instruction: { type: Type.STRING }
                                }
                            }
                        }
                    }
                },
                ...getThinkingConfig(settings, true)
            }
        }));
        if (response.text) return JSON.parse(response.text);
        return { hasConflicts: false, fixes: [] };
    } catch(e) {
        console.error("Batch Validate Error", e);
        return { hasConflicts: false, fixes: [] };
    }
};

// --- NEW: Apply Logic Fixes ---
export const applyLogicFixes = async (node: NodeData, instruction: string, settings: AppSettings): Promise<string> => {
    // We use refineContent here, but explicit prompt to ensure we fix logic while keeping context
    return await refineContent(node.summary, `【逻辑修复请求】\n针对问题：${instruction}\n请微调当前摘要以修复此逻辑问题。请保留原有的核心事件，仅修改有问题的地方。如果是删除助手语，请直接输出纯净的内容。`, settings);
};

// 2. Node Expansion (Strict Hierarchy & Logic)
export const generateNodeExpansion = async (params: AIRequestParams): Promise<Partial<NodeData>[]> => {
  const { currentNode, parentContext, prevContext, nextContext, globalContext, settings, task, expansionConfig, milestoneConfig } = params;
  const ai = createAI(settings);
  
  // Determine strict child type
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

  let taskPrompt = "";
  
  if (task === 'EXPAND') {
      // CASE 1: ROOT -> OUTLINE (Worldview -> Volumes/Grand Dungeons)
      if (currentNode.type === NodeType.ROOT) {
           const count = milestoneConfig?.generateCount || 3;
           taskPrompt = `
             任务：【全书分卷规划】 (Volume Outline Generation)
             当前书名：${currentNode.title}
             【世界观与主线设定 (Bible)】：
             ${currentNode.content} 
             
             目标：依据世界观中的【主线宏愿】，推演小说的前 ${count} 个“分卷 (OUTLINE)”。
             
             **核心要求（必须生成纯净的内容，严禁包含提示词）：**
             1. **格式规范**：Title 必须是 "第一卷：[卷名]" 的格式。
             2. **内容丰富度**：每个 Summary 代表 20-50 万字的内容，必须极其详尽。
                - **地图流转**：明确写出本卷涉及的 2-3 个大地图（例如：青阳镇 -> 天元城 -> 上古战场）。
                - **事件链条**：起因（卷首危机） -> 发展（换地图/升级） -> 转折（遭遇宿敌/发现阴谋） -> 高潮（卷末大战） -> 结局（收获/伏笔）。
             3. **禁止事项**：
                - 严禁输出 "好的，这是大纲" 之类的废话。
                - 严禁输出 "本卷主要讲述了..." 的概括语，直接讲故事。
           `;
      } 
      // CASE 2: OUTLINE -> PLOT (Volume -> Plot Points/Detailed Outline)
      else if (currentNode.type === NodeType.OUTLINE) {
           const total = milestoneConfig?.totalPoints || 10;
           const count = milestoneConfig?.generateCount || 5;
           
           taskPrompt = `
             任务：【细化剧情详纲 (Detailed Plot Outline)】
             当前分卷：${currentNode.title}
             【分卷大纲】：
             ${currentNode.content}
             
             本卷总计约 ${total} 个剧情点。请为我生成接下来的 ${count} 个关键【剧情详纲节点 (PLOT)】。
             
             **核心生成规则（拒绝流水账，必须是强因果的事件链）：**
             1. **每个 PLOT 节点代表一个完整的“剧情单元”**（通常包含3-5章正文）。
             2. 不要只描述地点！要描述发生了什么。
             3. **Summary 必须采用【节拍器】格式撰写**，包含以下要素：
                - 【核心冲突】：主角面临什么危机或目标？
                - 【关键交互】：遇见了谁（关联角色）？发现了什么（关联物品/线索）？
                - 【事件推演】：
                  1. [起因] ...
                  2. [行动/转折] ...
                  3. [高潮] ...
                  4. [结果/收获] ... (明确获得了什么，或引发了什么新危机)
             4. 确保剧情点之间紧密相连，上一个节点的【结果】是下一个节点的【起因】。
           `;
      } 
      // CASE 3: PLOT -> CHAPTER (Plot Point -> Chapters/Events)
      else if (currentNode.type === NodeType.PLOT) {
          const count = expansionConfig?.chapterCount || 3;
          const words = expansionConfig?.wordCount || '3000';
          
          taskPrompt = `
            任务：【章节拆分与事件排布】
            当前剧情单元：${currentNode.title}
            【剧情详纲】：
            ${currentNode.content}
            
            **核心前提：**
            该 PLOT 节点是一个剧情单元，现在需要将其落实为具体的章节 (CHAPTER)。
            
            目标：将上述详纲拆分为 ${count} 个具体的“章节”。
            
            **核心要求（三事件原则）：**
            1. **每一章必须包含至少 3 个完整事件**。
            2. 严禁注水。请列出每一章包含的具体哪 3-4 个事件。
            3. 事件之间必须紧密相连，上一事件的后果是下一事件的起因。
            4. 标题要吸引人（网文风格）。
            
            每章预期字数：${words} 字。
          `;
      } else {
          taskPrompt = `任务：细化节点 ${currentNode.title}`;
      }

  } else if (task === 'CONTINUE') {
      taskPrompt = nextContext 
        ? `任务：【插入过渡剧情】在 ${currentNode.title} 和 ${nextContext.title} 之间插入一个过渡节点。必须解决两个事件点之间的逻辑断层。`
        : `任务：【续写后续剧情】基于 ${currentNode.title} 的结局，推演下一个逻辑紧密的剧情单元。需包含新的危机或目标。`;
  } else if (task === 'BRAINSTORM') {
       taskPrompt = `任务：头脑风暴。基于当前情节，提供 3 个高价值的反转或冲突创意（例如：信任的人背叛、获得的宝物有副作用、强敌突然降临）。`;
  }

  const prompt = `
    ${taskPrompt}
    
    【世界观/全局上下文】：${globalContext}
    【上级脉络 (Parent)】：${parentContext?.title} - ${parentContext?.summary}
    【前情提要 (Previous)】：${prevContext?.title} - ${prevContext?.summary}

    请返回 JSON 数组，包含 'title' (简短标题), 'summary' (详细的剧情推演内容)。
  `;

  try {
    const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
      model: settings.modelName,
      contents: prompt,
      config: {
        systemInstruction: settings.systemInstruction,
        temperature: settings.temperature,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              summary: { type: Type.STRING },
              type: { type: Type.STRING, nullable: true } 
            },
            required: ['title', 'summary']
          }
        },
        // Expansion needs thinking to ensure plot consistency
        ...getThinkingConfig(settings, true)
      }
    }));

    if (response.text) {
        const result = JSON.parse(response.text);
        return result.map((item: any) => ({
            title: item.title,
            summary: item.summary,
            type: item.type || targetType, 
            content: item.summary // Initialize content with summary
        }));
    }
    return [];
  } catch (error) {
    console.error("Expansion Error:", error);
    throw error;
  }
};

// 3. Chapter Content Writing (Prose) with Rolling Context
export const generateChapterContent = async (params: AIRequestParams): Promise<string> => {
    const { currentNode, parentContext, prevContext, globalContext, storyContext, settings } = params;
    const ai = createAI(settings);
    
    // Extract Previous Chapter Ending (Strict logic)
    const prevContent = prevContext?.content || "";
    const prevContentEnding = prevContent.length > 500 ? prevContent.slice(-500) : prevContent;
    
    const notes = currentNode.content ? `【本章事件大纲】：${currentNode.content}` : "";

    const prompt = `
      任务：撰写正文 (高密度网文模式)。
      流派：${settings.novelStyle}
      
      【本章标题】：${currentNode.title}
      【本章摘要】：${currentNode.summary}
      ${notes}
      
      【所属剧情单元/详纲】：${parentContext?.title || '未知'} (详纲: ${parentContext?.content || ''})
      
      【上章结尾（必须无缝接龙）】：
      "...${prevContentEnding}"
      
      【关联设定】：${globalContext}

      **绝对写作禁令 (严格执行，否则任务失败)：**
      1. **严禁比喻与修辞**：禁止使用“像...一样”、“宛如”、“仿佛”等比喻句。使用【白描】手法，直接描写动作和神态。
      2. **对话驱动**：全章 60% 以上篇幅必须是对话。通过对话推动剧情。
      3. **极简环境描写**：全章最多只能出现 1 句环境描写，且必须一笔带过，除非对战斗环境有决定性影响。
      4. **动作描写为辅**：描写具体的肢体动作（如“他拔出剑”、“她皱眉”），坚决不要大段心理活动描写。
      5. **【最高优先级】禁止预示性结尾**：严禁在结尾写“他不知道的是...”、“这仅仅是开始...”、"命运的齿轮..."、“一场风暴正在酝酿”等总结性或预示性的话语。这是网文大忌！
      6. **【最高优先级】自然断章**：章节必须结束在某句具体的【对话】、具体的【动作】或某个突发的【事件瞬间】。例如：“剑尖停在他喉咙一寸处。”（好） vs “这场战斗让他明白了许多道理。”（差）。
      
      输出要求：
      - Markdown 格式。
      - 字数控制在 2000-3000 字左右。
      - 直接开始正文，不需要写标题。
    `;

    try {
        const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
            config: { 
                temperature: 0.9,
             } 
        }));
        return response.text || '';
    } catch (error) {
        console.error("Writing Error:", error);
        throw error;
    }
};

// --- NEW: Validate Chapter Ending (Style Check) ---
export const validateEndingStyle = async (text: string, settings: AppSettings): Promise<{ isValid: boolean, fixInstruction: string }> => {
    if (!text || text.length < 200) return { isValid: true, fixInstruction: "" };
    
    // Check last 800 chars to cover trailing paragraphs
    const ending = text.slice(-800); 
    const ai = createAI(settings);
    
    const prompt = `
        任务：检查小说章节结尾是否违规（防出戏检查）。
        【结尾片段】：
        "...${ending}"
        
        **违规判定标准（命中任意一条即为 Invalid）**：
        1. **预示未来**：出现了“命运的齿轮”、“他不知道未来会发生什么”、“这仅仅是个开始”、“风暴即将来临”等上帝视角的预告。
        2. **总结陈词**：出现了对本章内容的总结、感悟或升华（例如“经过这一战，他成长了...”）。
        3. **非动作/对话结尾**：结尾落在心理活动或环境描写上，而不是具体的【动作】、【对话】或【突发事件】。

        返回 JSON: { "isValid": boolean, "fixInstruction": string }
        isValid: true (合格) | false (违规).
        fixInstruction: 如果 false，请给出修改指令。例如：“删除最后两段关于命运的感叹，直接结束在男主说‘滚’的那一刻。”
    `;

    try {
        const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        isValid: { type: Type.BOOLEAN },
                        fixInstruction: { type: Type.STRING }
                    },
                    required: ['isValid', 'fixInstruction']
                }
            }
        }));
        if (response.text) return JSON.parse(response.text);
        return { isValid: true, fixInstruction: "" };
    } catch (e) {
        return { isValid: true, fixInstruction: "" };
    }
};

// 4. Polish / Refine Content
export const refineContent = async (text: string, instruction: string, settings: AppSettings): Promise<string> => {
    const ai = createAI(settings);
    const prompt = `
        任务：【内容微调与润色】
        
        原文内容：
        "${text}"

        用户指令：${instruction}
        小说风格：${settings.novelStyle}

        要求：
        1. **保留原意**：不要大改剧情走向，除非指令明确要求。仅针对指令指出的问题进行局部修改。
        2. **执行指令**：严格按照用户指令进行修改（例如删除结尾、增加动作）。
        3. **风格保持**：坚持【白描】和【对话驱动】原则。
        4. 直接返回修改后的完整文本。
    `;
    
    const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
        model: settings.modelName,
        contents: prompt
    }));
    return response.text || text;
};

// 5. Incremental Lore Sync (Reverse Update) - Keep this for manual sync in EditorPanel
export const extractLoreUpdates = async (chapterText: string, relevantNodes: NodeData[], settings: AppSettings): Promise<LoreUpdateSuggestion[]> => {
    if (relevantNodes.length === 0) return [];
    
    const ai = createAI(settings);
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
    `;

    try {
        const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            targetId: { type: Type.STRING },
                            originalSummary: { type: Type.STRING },
                            newSummary: { type: Type.STRING },
                            reason: { type: Type.STRING }
                        },
                        required: ['targetId', 'newSummary', 'reason']
                    }
                }
            }
        }));
        if (response.text) return JSON.parse(response.text);
        return [];
    } catch (error) {
        console.error("Lore Sync Error", error);
        return [];
    }
};

// --- NEW: Background World State Analyzer ---
export const autoExtractWorldInfo = async (
    textToAnalyze: string,
    existingResources: NodeData[],
    settings: AppSettings
): Promise<WorldStateAnalysis> => {
    if (!textToAnalyze || textToAnalyze.length < 50) return { newResources: [], updates: [], mentionedIds: [] };

    const ai = createAI(settings);
    
    // Prepare resource context
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
        
        请返回 JSON:
        {
          "newResources": [ { "type": "CHARACTER"|"ITEM"|"LOCATION"|"FACTION", "title": "...", "summary": "..." } ],
          "updates": [ { "id": "...", "newSummary": "...", "changeLog": "..." } ],
          "mentionedIds": [ "..." ]
        }
    `;

    try {
        const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        newResources: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    type: { type: Type.STRING, enum: ['CHARACTER', 'ITEM', 'LOCATION', 'FACTION'] },
                                    title: { type: Type.STRING },
                                    summary: { type: Type.STRING }
                                },
                                required: ['type', 'title', 'summary']
                            }
                        },
                        updates: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    id: { type: Type.STRING },
                                    newSummary: { type: Type.STRING },
                                    changeLog: { type: Type.STRING }
                                },
                                required: ['id', 'newSummary', 'changeLog']
                            }
                        },
                        mentionedIds: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING }
                        }
                    },
                    required: ['newResources', 'updates', 'mentionedIds']
                }
            }
        }));
        
        if (response.text) return JSON.parse(response.text);
        return { newResources: [], updates: [], mentionedIds: [] };

    } catch (e) {
        console.error("Auto Extract World Info Error", e);
        return { newResources: [], updates: [], mentionedIds: [] };
    }
};

// 6. Structured Meta-Prompt Generator
export const generateRefinementPrompt = async (
    nodeType: NodeType,
    contextSummary: string,
    userIntent: string,
    settings: AppSettings
): Promise<string> => {
    const ai = createAI(settings);
    
    let roleDescription = "";
    switch(nodeType) {
        case NodeType.ROOT: roleDescription = "资深世界观架构师"; break;
        case NodeType.OUTLINE: roleDescription = "副本关卡策划"; break;
        case NodeType.PLOT: roleDescription = "金牌剧情编剧"; break;
        case NodeType.CHAPTER: roleDescription = "起点/晋江金牌大神作家"; break;
        default: roleDescription = "资深编辑";
    }

    // Customized prompt generation based on node type
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

    try {
        const response = await callAIWithRetry<GenerateContentResponse>(() => ai.models.generateContent({
            model: settings.modelName,
            contents: prompt
        }));
        return response.text?.trim() || userIntent;
    } catch (e) {
        return userIntent;
    }
};