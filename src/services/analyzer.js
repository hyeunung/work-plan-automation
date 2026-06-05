/**
 * 세부 불릿 텍스트와 일지 제목/내용 간의 매칭 알고리즘
 */
function isMatching(bullet, logTitle, logDetails = '') {
  const cleanBullet = bullet.replace(/[✅❌•\-\s]/g, '').toLowerCase();
  const cleanLogTitle = logTitle.toLowerCase();
  const cleanLogDetails = logDetails.toLowerCase();

  if (!cleanBullet) return false;

  const synonymRules = [
    { bullet: '기상청', logKeywords: ['날씨', '기상청', '익일 예보'] },
    { bullet: 'dto수정', logKeywords: ['dto', '간소화', '수정'] },
    { bullet: '목업', logKeywords: ['목업', 'mock'] },
    { bullet: '센서별변화추이', logKeywords: ['센서', '차트', '모달', '스펙'] },
    { bullet: '기기별카테고리', logKeywords: ['디바이스', '카테고리', '필드 제거'] },
    { bullet: '명세api적용', logKeywords: ['상세조회', '명세', 'api'] },
    { bullet: '자동화카테고리', logKeywords: ['자동화', '카테고리'] }
  ];

  for (const rule of synonymRules) {
    if (cleanBullet.includes(rule.bullet)) {
      const matchInTitle = rule.logKeywords.every(keyword => cleanLogTitle.includes(keyword));
      const matchInDetails = rule.logKeywords.every(keyword => cleanLogDetails.includes(keyword));
      if (matchInTitle || matchInDetails) return true;
    }
  }

  // 1단계 안전장치: 완전 100% 매칭인 경우 즉시 true
  if (cleanLogTitle.includes(cleanBullet) || cleanLogDetails.includes(cleanBullet)) {
    return true;
  }

  // 2단계 안전장치: 글자 수가 너무 짧은 키워드는 자형(Char-by-Char) 유사도 오탐을 완벽 차단하기 위해 제외!
  // 영문 10자 이하, 한글 4자 이하인 극히 짧은 키워드는 글자 단위 유사도 판정을 원천 금지합니다.
  const isEnglishOnly = /^[a-zA-Z0-9\s-_]+$/.test(cleanBullet);
  const isShortWord = isEnglishOnly ? (cleanBullet.length <= 10) : (cleanBullet.length <= 4);

  if (isShortWord) {
    return false;
  }

  // 3단계: 단어의 글자 수가 충분히 길 때만 글자 기반 유사도 매칭 수행 (임계치를 상향 보정)
  const chars = cleanBullet.split('');
  let matchCountTitle = 0;
  let matchCountDetails = 0;

  for (const char of chars) {
    if (cleanLogTitle.includes(char)) matchCountTitle++;
    if (cleanLogDetails.includes(char)) matchCountDetails++;
  }

  const ratioTitle = matchCountTitle / chars.length;
  const ratioDetails = matchCountDetails / chars.length;

  // 제목과의 매칭은 75% 이상, 본문과의 매칭은 85% 이상일 때만 매우 깐깐하게 매칭 인정!
  if (ratioTitle > 0.75 || ratioDetails > 0.85) {
    return true;
  }

  return false;
}

/**
 * Weekly Plan의 '할 일' rich_text 속성을 계층적으로 분석하고 일지 데이터와 매핑합니다.
 */
function analyzeWork(weeklyPage, dailyLogs, tasksMap) {
  const richTextElements = weeklyPage.properties['할 일']?.rich_text || [];
  
  const analysisResults = [];
  let currentTask = null;
  let currentProject = null;

  for (let i = 0; i < richTextElements.length; i++) {
    const elem = richTextElements[i];

    if (elem.type === 'mention' && elem.mention.type === 'page') {
      const taskId = elem.mention.page.id;
      const rawName = elem.plain_text || '알 수 없는 태스크';
      
      const taskInfo = tasksMap[taskId];
      
      // 1단계: 멘션이 진짜 하위 태스크인지, 아니면 상위 프로젝트/그룹인지 판단
      // Tasks DB에 정보가 있고, 상위 프로젝트명이 기재되어 있다면 하위 태스크로 판정!
      const isRealTask = taskInfo && taskInfo.projectName && taskInfo.projectName !== '스마트팜 외 업무';
      
      if (isRealTask) {
        // 진짜 하위 태스크를 만난 경우
        currentTask = {
          taskId,
          taskName: taskInfo.name || rawName,
          taskUrl: taskInfo.url || '',
          dueDate: taskInfo.dueDate || '',
          projectName: taskInfo.projectName || (currentProject ? currentProject.name : ''),
          subItems: [],
          rawElement: elem
        };
        analysisResults.push(currentTask);
      } else {
        // 상위 프로젝트 또는 그룹인 경우 (예: "스마트팜 외 업무", "무인대차 1차 프로토타입")
        currentProject = {
          id: taskId,
          name: rawName
        };
        
        // 상위 프로젝트 자체도 캔버스 대조 표나 갱신에 나타날 수 있도록 독립 태스크로서 등록은 해주되,
        // 하위 태스크가 존재할 경우 계층적으로 렌더링되게 설계합니다.
        currentTask = {
          taskId,
          taskName: rawName,
          taskUrl: taskInfo?.url || '',
          dueDate: taskInfo?.dueDate || '',
          projectName: '', // 상위 프로젝트 자체이므로 공백
          subItems: [],
          rawElement: elem,
          isProjectGroup: true // 상위 그룹 마킹!
        };
        analysisResults.push(currentTask);
      }

    } else if (elem.type === 'text') {
      const textVal = elem.text.content;
      const lines = textVal.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // 정형화된 불릿 라인 판정 정규식 적용 (•, -, *, ◦, ▪, ▫, ▶, ▷, ·, ⁃ 등 모든 노션 불릿 대응)
        if (/^[ \t]*[•\-\*◦▪▫▶▷·⁃]/.test(line)) {
          const isAlreadyChecked = trimmed.includes('✅');
          
          let cleanItemName = trimmed
            .replace(/^[•\-\*\s◦▪▫▶▷·⁃]+/, '') // 불릿 및 공백 소거
            .replace(/✅.*/, '')        // 체크 표시 이후 텍스트 소거
            .trim();

          // ⚠️ 만약 불릿 기호 외에 알맹이가 전혀 없는 빈 공백 줄(예: "  • ")이라면 subItem에 적재하지 않고 완벽 스킵!
          if (!cleanItemName) {
            continue;
          }

          const matchingLog = dailyLogs.find(log => isMatching(cleanItemName, log.title, log.details));

          if (currentTask) {
            currentTask.subItems.push({
              rawLine: line,
              itemName: cleanItemName,
              isCompleted: !!matchingLog || isAlreadyChecked,
              matchingLog: matchingLog || null,
              isAlreadyChecked
            });
          }
        }
      }
    }
  }

  return analysisResults;
}

/**
 * rich_text의 길이가 Notion API 한계(100개)를 넘지 않도록 연속되는 일반 텍스트 요소를 하나로 축소 병합(Compression)합니다.
 */
function compressRichText(richTextArray) {
  const compressed = [];
  let lastTextObj = null;

  for (const elem of richTextArray) {
    if (elem.type === 'text') {
      if (lastTextObj) {
        // 이전 요소와 현재 요소가 모두 일반 텍스트인 경우 content 병합
        lastTextObj.text.content += elem.text.content;
      } else {
        // 새로운 텍스트 객체 생성 (참조 복사 방지)
        lastTextObj = {
          type: 'text',
          text: { content: elem.text.content }
        };
        compressed.push(lastTextObj);
      }
    } else {
      // 멘션 객체 등 텍스트가 아닌 경우 즉시 그대로 추가하고 텍스트 병합 상태 해제
      compressed.push(elem);
      lastTextObj = null;
    }
  }

  return compressed;
}

/**
 * 완료된 항목들에 대해 Notion Write-Back을 할 수 있도록 새로운 rich_text 배열을 조립하고 병합 압축을 수행합니다.
 */
function buildUpdatedRichText(weeklyPage, analysisResults) {
  const originalElements = weeklyPage.properties['할 일']?.rich_text || [];
  
  // 1. 단계: 전체 rich_text 요소들을 순수 문자열 템플릿으로 평탄화(Flatten)
  // 이때, 쓸데없는 꼬리표 멘션(일지 멘션, 중복 멘션)은 아예 템플릿에 넣지 않고 영구 삭제!
  let flatText = '';
  
  for (let i = 0; i < originalElements.length; i++) {
    const elem = originalElements[i];
    
    if (elem.type === 'mention' && elem.mention.type === 'page') {
      const taskId = elem.mention.page.id;
      // 오직 수집된 상위 Task ID 리스트에 속하는 진짜 상위 멘션만 템플릿에 흔적을 남겨둠
      const isParentTask = analysisResults.some(r => r.taskId === taskId);
      if (isParentTask) {
        flatText += `__PARENT_TASK_MENTION_${taskId}__`;
      }
    } else if (elem.type === 'text') {
      flatText += elem.text.content;
    }
  }

  // 2. 단계: 평탄화된 텍스트를 라인별로 정밀 쪼개서 클린업 및 재구성
  const lines = flatText.split('\n');
  const updatedElements = [];
  
  let currentTask = null;
  let subItemIndex = 0;

  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    const trimmed = line.trim();
    
    const isLastLine = j === lines.length - 1;
    const lineEnding = isLastLine ? '' : '\n';

    // 진짜 상위 Task MENTION 토큰을 만난 경우
    if (trimmed.includes('__PARENT_TASK_MENTION_')) {
      const match = trimmed.match(/__PARENT_TASK_MENTION_([a-f0-9\-]+)__/);
      if (match) {
        const taskId = match[1];
        currentTask = analysisResults.find(r => r.taskId === taskId);
        subItemIndex = 0; // 새 태스크를 만났으므로 서브아이템 매핑 인덱스 초기화!
        
        // 📄 상위 Task 아이콘 텍스트 복구
        updatedElements.push({
          type: 'text',
          text: { content: '📄 ' }
        });
        
        // 진짜 상위 Task Page 멘션 객체 복구!
        updatedElements.push({
          type: 'mention',
          mention: {
            type: 'page',
            page: { id: taskId }
          }
        });

        // 뒤에 줄바꿈 붙임
        updatedElements.push({
          type: 'text',
          text: { content: lineEnding }
        });
        continue;
      }
    }

    // 빈 라인인 경우 그대로 유지
    if (!trimmed) {
      updatedElements.push({
        type: 'text',
        text: { content: line + lineEnding }
      });
      continue;
    }

    // 불릿 라인인 경우 (•, -, *, ◦, ▪, ▫, ▶, ▷, ·, ⁃ 등 모든 노션 불릿 대응)
    if (/^[ \t]*[•\-\*◦▪▫▶▷·⁃]/.test(line)) {
      if (currentTask) {
        const subItem = currentTask.subItems[subItemIndex++];
        
        // 기존에 붙어있던 모든 지저분한 ✅ 마크와 그 뒤 텍스트 흔적들(날짜, 멘션 텍스트 찌꺼기 등)을 100% 도려냄
        const cleanBaseLine = line.replace(/✅.*/, '').replace(/\s*$/, '');

        if (subItem && subItem.isCompleted) {
          // 완료된 경우: 오직 깔끔하게 공백 한 칸 + ✅ 만 안전하게 붙임!
          updatedElements.push({
            type: 'text',
            text: { content: `${cleanBaseLine} ✅${lineEnding}` }
          });
        } else {
          // 미완료된 경우: 꼬임 흔적을 다 지운 순수 오리지널 불릿 텍스트만 복구!
          updatedElements.push({
            type: 'text',
            text: { content: `${cleanBaseLine}${lineEnding}` }
          });
        }
      } else {
        // 혹시 상위 Task 매칭이 안 된 불릿은 기존 라인 그대로 유지
        updatedElements.push({
          type: 'text',
          text: { content: line + lineEnding }
        });
      }
    } else {
      // 일반 설명이나 메모 텍스트 줄
      updatedElements.push({
        type: 'text',
        text: { content: line + lineEnding }
      });
    }
  }

  // 3. 단계: 연속된 text 요소 병합 압축을 거쳐 최종 Notion rich_text 규격에 맞춰 리턴!
  return compressRichText(updatedElements);
}

module.exports = {
  isMatching,
  analyzeWork,
  buildUpdatedRichText
};
