
import { GoogleGenAI, Type } from "@google/genai";
import { AIRequestParams, NodeType, NodeData, LogicValidationResult, LoreUpdateSuggestion, AppSettings, WorldStateAnalysis } from '../types';

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
        const response = await ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
            config: {
                systemInstruction: settings.systemInstruction, 
                temperature: 0.85,
                // Worldview creation benefits heavily from thinking
                ...getThinkingConfig(settings, true) 
            }
        });
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
        const response = await ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
        });
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
        const response = await ai.models.generateContent({
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
        });
        if (response.text) return JSON.parse(response.text);
        throw new Error("Empty response");
    } catch (error) {
        return { valid: false, score: 0, issues: ["API Error"], suggestions: [] };
    }
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
           taskPrompt = `
             任务：【全书分卷剧情推演】
             当前书名：${currentNode.title}
             【世界观与主线设定 (Bible)】：
             ${currentNode.content} 
             
             目标：依据世界观中的【主线宏愿】，推演小说的前 3-5 个“分卷 (OUTLINE)”。
             
             **核心要求（事件驱动的大纲）：**
             1. **严禁静态描述**：不要写“主角变得很强”或“登上王座”这种状态。
             2. **必须基于事件链**：Summary 必须包含该卷的【核心冲突】->【关键转折事件】->【高潮战役/事件】->【结尾获得的结果】。
             3. **地图层级绑定**：每一卷必须明确发生在哪个“大地图/大副本”中（例如：第一卷-新手村风云；第二卷-血色试炼之地）。
             4. **主线逻辑**：每一卷的结尾事件，必须是下一卷危机的直接起因，体现因果逻辑。
           `;
      } 
      // CASE 2: OUTLINE -> PLOT (Volume -> Areas/Plot Points)
      else if (currentNode.type === NodeType.OUTLINE) {
           const total = milestoneConfig?.totalPoints || 60;
           const count = milestoneConfig?.generateCount || 5;
           
           taskPrompt = `
             任务：【区域剧情锚点生成】
             当前分卷：${currentNode.title}
             【分卷大纲（包含大副本规划）】：
             ${currentNode.content}
             
             本卷预计包含 ${total} 个剧情关键节点。
             请为我生成其中 ${count} 个关键的【剧情锚点 (PLOT)】。
             
             **核心要求（区域与事件）：**
             1. **每个 Plot 节点代表一个大副本中的【特定区域】（Area）**。
             2. 一个大副本通常包含 10 个左右的区域。请根据大纲中的大副本设定，规划这些区域的流转。
             3. **每个 Plot 节点必须隐含至少 10 个“事件”**（主角在区域内的探索、战斗、交互序列）。
             4. 摘要中必须描述：主角在这个区域遇到了什么？做了什么关键选择？
           `;
      } 
      // CASE 3: PLOT -> CHAPTER (Plot Point -> Chapters/Events)
      else if (currentNode.type === NodeType.PLOT) {
          const count = expansionConfig?.chapterCount || 3;
          const words = expansionConfig?.wordCount || '3000';
          
          taskPrompt = `
            任务：【章节拆分与事件排布】
            当前区域/剧情点：${currentNode.title}
            【区域剧情详纲】：
            ${currentNode.content}
            
            **核心前提：**
            该 Plot 节点包含约 10 个事件（事件 = 选择+行动+后果）。
            
            目标：将这些高密度的事件拆分为 ${count} 个“章节(CHAPTER)”。
            
            **核心要求（三事件原则）：**
            1. **每一章必须包含至少 3 个完整事件**。
            2. 严禁注水。请列出每一章包含的具体哪 3-4 个事件。
            3. 事件之间必须紧密相连，上一事件的后果是下一事件的起因。
            
            每章预期字数：${words} 字。
          `;
      } else {
          taskPrompt = `任务：细化节点 ${currentNode.title}`;
      }

  } else if (task === 'CONTINUE') {
      taskPrompt = nextContext 
        ? `任务：【插入过渡节点】在 ${currentNode.title} 和 ${nextContext.title} 之间插入一个过渡节点。必须包含有效的地图移动或事件推进。`
        : `任务：【续写节点】基于 ${currentNode.title} 的内容，构思下一个逻辑连续的节点。需包含新的事件（选择->行动->后果）。`;
  } else if (task === 'BRAINSTORM') {
       taskPrompt = `任务：头脑风暴。基于当前地图和情节，提供 3 个高价值事件创意（如发现隐藏区域、触发连环任务、遭遇稀有精英怪）。`;
  }

  const prompt = `
    ${taskPrompt}
    
    【世界观/全局上下文】：${globalContext}
    【上级脉络 (Parent)】：${parentContext?.title} - ${parentContext?.summary}
    【前情提要 (Previous)】：${prevContext?.title} - ${prevContext?.summary}

    请返回 JSON 数组，包含 'title' (标题), 'summary' (详细描述)。
  `;

  try {
    const response = await ai.models.generateContent({
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
    });

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
    
    const notes = currentNode.content ? `【本章事件大纲】：${currentNode.content}` : "";

    const prompt = `
      任务：撰写正文 (高密度网文模式)。
      流派：${settings.novelStyle}
      
      【本章标题】：${currentNode.title}
      【本章摘要】：${currentNode.summary}
      ${notes}
      
      【所属区域/副本】：${parentContext?.title || '未知'} (区域详纲: ${parentContext?.content || ''})
      
      【前情回顾】：
      ${storyContext || "（暂无前文信息，这是开头）"}
      
      【紧接上章】：${prevContext ? prevContext.title + " (结尾: " + prevContext.content.slice(-300) + "...)" : "这是第一章"}
      
      【关联设定】：${globalContext}

      **绝对写作要求（三事件原则）：**
      1. **本章必须写完至少 3 个完整的事件单位**。
      2. **事件单位定义**：主角面临选择 -> 做出行动 -> 产生后果（不仅是心理活动，必须有外部反馈，如对话、战斗、获得道具）。
      3. 节奏要快，禁止大段无意义的环境描写或心理独白，除非与后续选择强相关。
      4. 输出 Markdown 格式。
    `;

    try {
        const response = await ai.models.generateContent({
            model: settings.modelName,
            contents: prompt,
            config: { 
                temperature: 0.9,
             } 
        });
        return response.text || '';
    } catch (error) {
        console.error("Writing Error:", error);
        throw error;
    }
};

// 4. Polish / Refine Content
export const refineContent = async (text: string, instruction: string, settings: AppSettings): Promise<string> => {
    const ai = createAI(settings);
    const prompt = `
        任务：【内容润色与优化】
        
        原文内容：
        "${text}"

        用户指令：${instruction}
        小说风格：${settings.novelStyle}

        要求：
        1. 保持原意。
        2. **增强事件的颗粒度**：如果用户觉得水，请增加主角的行动和交互细节，减少空洞描写。
        3. 确保逻辑链条（选择->后果）清晰。
        4. 直接返回修改后的完整文本。
    `;
    
    const response = await ai.models.generateContent({
        model: settings.modelName,
        contents: prompt
    });
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
        const response = await ai.models.generateContent({
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
        });
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
        const response = await ai.models.generateContent({
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
        });
        
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
        case NodeType.PLOT: roleDescription = "剧情事件编剧"; break;
        case NodeType.CHAPTER: roleDescription = "起点/晋江金牌大神作家"; break;
        default: roleDescription = "资深编辑";
    }

    const prompt = `
        任务：你是${roleDescription}。请根据用户的【模糊意图】，将其转化为一条**结构化、高执行力**的AI Prompt。
        
        【当前场景】：
        - 节点层级：${nodeType}
        - 小说流派：${settings.novelStyle}
        - 内容摘要：${contextSummary.slice(0, 200)}...
        
        【用户模糊意图】："${userIntent}"
        
        **特别注意**：
        - 如果是 PLOT/CHAPTER 层级，请关注事件密度（选择->行动->后果）。
        - 如果是 OUTLINE 层级，请关注地图副本的层级跃迁。

        【生成要求】：
        请输出一段完整的提示词（Prompt），包含以下结构：
        [角色设定]: 指定AI扮演的角色。
        [任务目标]: 明确要改什么。
        [风格要求]: 结合流派。
        [修改规则]: 列出3条具体的修改准则。

        请直接输出生成的Prompt内容，不要包含其他解释。
    `;

    try {
        const response = await ai.models.generateContent({
            model: settings.modelName,
            contents: prompt
        });
        return response.text?.trim() || userIntent;
    } catch (e) {
        return userIntent;
    }
};
