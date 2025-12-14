
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
        - 既然是${settings.novelStyle}，请确保术语地道。
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
        3. 强调【地图副本推进】的结构：每卷包含2-3个大副本。
        4. 强调【高密度事件】：主角的选择->行动->后果，每章至少3个事件。
        5. 保持指令清晰，直接返回优化后的提示词内容。
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
      1. **事件密度**：是否达到了“高密度”标准？(一章应包含至少3个有效事件)。
      2. **行为逻辑**：主角的选择是否符合利益最大化或人设？
      3. **战力/设定**：是否与世界观冲突？

      返回 JSON 格式: 
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
    const nodesText = nodesToCheck.map((n) => 
        `[ID: ${n.id}] [Type: ${n.type}]\nTITLE: ${n.title}\nCONTENT: ${n.summary}`
    ).join('\n----------------\n');

    const prompt = `
        角色：【逻辑精修师】
        任务：检查以下一组连续剧情节点的逻辑连贯性与质量。
        【全局设定】：${globalContext}
        【上级大纲】：${parent.title} - ${parent.summary}
        
        【待检查节点链】：
        ${nodesText}
        
        请审查：
        1. 逻辑断层：前一个节点的结局是否引发下一个节点的开端？
        2. 内容质量：是否内容贫乏（如只有一句话）？是否包含AI助手语（Meta文本）？
        
        返回 JSON: 
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
    return await refineContent(node.summary, `【逻辑修复】针对问题：${instruction}。请微调摘要以修复此问题。保留核心事件。`, settings);
};

// --- 3. Node Expansion (The Core) ---

export const generateNodeExpansion = async (params: AIRequestParams): Promise<Partial<NodeData>[]> => {
  const { currentNode, parentContext, prevContext, nextContext, globalContext, settings, task, expansionConfig, milestoneConfig } = params;
  
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

  let taskPrompt = "";
  if (task === 'EXPAND') {
      if (currentNode.type === NodeType.ROOT) {
           const count = milestoneConfig?.generateCount || 3;
           taskPrompt = `任务：推演前 ${count} 个“分卷 (OUTLINE)”。格式：Title必须是"第一卷：xxx"。内容必须详尽，包含地图流转和核心冲突。`;
      } 
      else if (currentNode.type === NodeType.OUTLINE) {
           const count = milestoneConfig?.generateCount || 5;
           taskPrompt = `任务：生成接下来的 ${count} 个关键【剧情详纲节点 (PLOT)】。每个节点代表一个剧情单元。Summary必须包含【核心冲突】【关键交互】【事件推演】。`;
      } 
      else if (currentNode.type === NodeType.PLOT) {
          const count = expansionConfig?.chapterCount || 3;
          const words = expansionConfig?.wordCount || '3000';
          taskPrompt = `任务：将详纲拆分为 ${count} 个具体的“章节”。每一章必须包含至少3个完整事件。严禁注水。每章预期字数：${words}。`;
      }
  } else if (task === 'CONTINUE') {
      taskPrompt = nextContext 
        ? `任务：【插入过渡】在 ${currentNode.title} 和 ${nextContext.title} 之间插入一个过渡节点。`
        : `任务：【续写】基于 ${currentNode.title} 的结局，推演下一个逻辑紧密的剧情节点。`;
  }

  const prompt = `
    ${taskPrompt}
    
    【世界观】：${globalContext}
    【上级脉络】：${parentContext?.title || 'ROOT'} - ${parentContext?.summary || ''}
    【前情提要】：${prevContext?.title || '无'} - ${prevContext?.summary || ''}

    请返回 JSON 数组: [ { "title": "string", "summary": "string" } ]
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
    const { currentNode, parentContext, prevContext, globalContext, settings } = params;
    
    const prevContentEnding = prevContext?.content ? prevContext.content.slice(-500) : "";
    const notes = currentNode.content ? `【本章大纲】：${currentNode.content}` : "";

    const prompt = `
      任务：撰写正文 (高密度网文模式)。
      流派：${settings.novelStyle}
      
      【本章标题】：${currentNode.title}
      【本章摘要】：${currentNode.summary}
      ${notes}
      
      【所属剧情单元】：${parentContext?.title || '未知'} 
      【上章结尾】："...${prevContentEnding}"
      【设定库】：${globalContext}

      **核心禁令**：
      1. 严禁使用“像...一样”等比喻句，使用白描。
      2. 全章 60% 以上篇幅必须是对话。
      3. 严禁环境描写，除非必要。
      4. **严禁在结尾进行总结或预示未来**（如“他不知道的是...”）。
      5. 必须自然断章（结束在动作或对话上）。
      
      请直接输出正文 Markdown，无需标题。字数要求 2000+。
    `;

    return await callOpenAI([
        { role: "system", content: settings.systemInstruction },
        { role: "user", content: prompt }
    ], settings);
};

export const validateEndingStyle = async (text: string, settings: AppSettings): Promise<{ isValid: boolean, fixInstruction: string }> => {
    if (!text || text.length < 200) return { isValid: true, fixInstruction: "" };
    
    const prompt = `
        任务：检查章节结尾是否违规。
        【结尾】："...${text.slice(-800)}"
        
        违规标准：
        1. 预示未来（“命运的齿轮...”）。
        2. 总结陈词（“经过这一战...”）。
        3. 心理活动结尾。

        返回 JSON: { "isValid": boolean, "fixInstruction": "string" }
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
        任务：【内容微调】
        原文： "${text}"
        用户指令：${instruction}
        
        要求：保留原意，仅针对指令修改。坚持白描和对话驱动。直接返回修改后的文本。
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
    const prompt = `
        任务：将用户的模糊意图转化为结构化的 Prompt。
        场景：${nodeType}。内容：${contextSummary.slice(0, 200)}...
        用户意图："${userIntent}"
        
        请输出一段 Prompt，包含：[角色][目标][规则][实例]。直接输出内容。
    `;
    return await callOpenAI([{ role: "user", content: prompt }], settings);
};

// --- 5. Background Tasks ---

export const extractLoreUpdates = async (chapterText: string, relevantNodes: NodeData[], settings: AppSettings): Promise<LoreUpdateSuggestion[]> => {
    if (relevantNodes.length === 0) return [];
    
    const nodesInfo = relevantNodes.map(n => `ID:${n.id} Name:${n.title} Summary:${n.summary}`).join('\n');
    
    const prompt = `
        任务：检查章节正文，提取关于关联角色的【新信息】（受伤、升级、新道具）。
        【正文】：${chapterText.slice(0, 5000)}...
        【关联设定】：${nodesInfo}
        
        返回 JSON 数组: [ { "targetId": "string", "newSummary": "string", "reason": "string" } ]
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

    const resourceContext = existingResources.map(r => `[ID:${r.id}] ${r.type} ${r.title}`).join('\n');

    const prompt = `
        任务：分析剧情，维护世界观。
        【剧情】："${textToAnalyze.slice(0, 5000)}..."
        【库】：${resourceContext}
        
        目标：
        1. 识别全新重要实体(CHARACTER/ITEM/LOCATION/FACTION)。
        2. 识别现有实体的状态变更。
        3. 列出提及的ID。
        
        返回 JSON:
        {
          "newResources": [ { "type": "string", "title": "string", "summary": "string" } ],
          "updates": [ { "id": "string", "newSummary": "string", "changeLog": "string" } ],
          "mentionedIds": [ "string" ]
        }
    `;

    try {
        const text = await callOpenAI([{ role: "system", content: "You are a World Database Admin." }, { role: "user", content: prompt }], settings, true);
        return JSON.parse(text);
    } catch (e) {
        return { newResources: [], updates: [], mentionedIds: [] };
    }
};
