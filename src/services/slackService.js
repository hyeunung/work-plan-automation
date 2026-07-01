const { WebClient } = require('@slack/web-api');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const supabaseService = require('./supabaseService');

const slack = new WebClient(config.slack.token);

const MEMBER_EMAILS = {
  '김윤회': 'yoon-whoi.kim@hansl.com',
  '김희승': 'hee-seung.kim@hansl.com',
  '최현빈': 'hyun-bin.choi@hansl.com'
};

const userIdCache = {};

/**
 * 채널명(예: '스마트팜-workplan')을 받아 해당하는 실시간 슬랙 채널 ID를 조회합니다.
 */
async function findChannelIdByName(channelName) {
  try {
    const cleanName = channelName.replace('#', '').trim();
    let cursor;
    
    while (true) {
      const response = await slack.conversations.list({
        types: 'public_channel,private_channel',
        cursor: cursor
      });

      const channel = response.channels.find(c => c.name === cleanName);
      if (channel) {
        console.log(`  -> 실시간 채널 감지 성공: #${cleanName} (ID: ${channel.id})`);
        return channel.id;
      }

      cursor = response.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    
    return config.slack.channelId;
  } catch (error) {
    console.error(`채널명 '${channelName}' 조회 실패:`, error.message);
    return config.slack.channelId;
  }
}

/**
 * AWS S3 Presigned URL의 ImgProxy 차단 우회를 위해 TinyURL로 단축합니다.
 */
async function getShortUrl(longUrl) {
  try {
    const encodedUrl = encodeURIComponent(longUrl);
    const apiUrl = `https://tinyurl.com/api-create.php?url=${encodedUrl}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`TinyURL API status error: ${response.status}`);
    }
    const shortUrl = await response.text();
    return shortUrl.trim() || longUrl;
  } catch (error) {
    console.error('TinyURL 단축 실패:', error.message);
    return longUrl;
  }
}

/**
 * 이미지 URL을 Supabase Storage에 백업 업로드하여 영구적인 Public URL을 반환합니다.
 * 업로드 실패 시 TinyURL 단축 주소로 fallback 합니다.
 */
async function getPermanentImageUrl(longUrl) {
  if (!longUrl) return '';
  
  // 이미 Supabase Storage workplan 버킷 경로라면 그대로 반환
  if (longUrl.includes('supabase.co/storage/v1/object/public/workplan')) {
    return longUrl;
  }
  
  try {
    const permanentUrl = await supabaseService.uploadImageToStorage(longUrl);
    // 업로드 실패 시 원본 URL이 반환되므로, 이 경우 TinyURL 단축 적용
    if (permanentUrl === longUrl) {
      console.warn('[Slack Service] Supabase 이미지 업로드 실패, TinyURL 단축을 적용합니다.');
      return await getShortUrl(longUrl);
    }
    return permanentUrl;
  } catch (error) {
    console.error('[Slack Service] 영구 이미지 URL 변환 중 예외 발생:', error.message);
    return await getShortUrl(longUrl);
  }
}


/**
 * 날짜 문자열을 받아 요일을 포함한 형식으로 변환합니다.
 */
function formatDayLabel(dateStr) {
  const dateObj = new Date(dateStr);
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  
  const weekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const dayOfWeek = weekdays[dateObj.getUTCDay()];

  return `${month}월 ${day}일 (${dayOfWeek})`;
}

/**
 * 텍스트 패딩 계산 함수 (한글 문자 너비 보정 포함)
 */
function getVisualWidth(str) {
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xac00 && code <= 0xd7a3 || code >= 0x3000 && code <= 0x303f || code >= 0xff00 && code <= 0xffef) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padRight(str, targetWidth) {
  const currentWidth = getVisualWidth(str);
  if (currentWidth >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - currentWidth);
}

/**
 * 100% 안전한 슬랙 캔버스용 마크다운 리포트 텍스트를 빌드합니다.
 */
function buildCanvasMarkdownContent({ weekTitle, nextWeekTitle, memberName, analysisResults, dailyLogs, nextWeekPlan, tasksMap, startDate, endDate }) {
  const cleanMemberName = memberName.replace(' 님', '');
  
  let markdownContent = `# 📅 [${weekTitle}] 주간 업무 브리핑\n`;
  markdownContent += `> 월요일 출근 시간 전, 지난주 업무 분석 및 금주 계획 종합 브리핑입니다.\n\n`;
  markdownContent += `---\n\n`;

  // 날짜 범위 포맷팅 (YYYY-MM-DD -> M/D~M/D)
  let periodLabel = '';
  if (startDate && endDate) {
    const startObj = new Date(startDate);
    const endObj = new Date(endDate);
    const startM = startObj.getUTCMonth() + 1;
    const startD = startObj.getUTCDate();
    const endM = endObj.getUTCMonth() + 1;
    const endD = endObj.getUTCDate();
    periodLabel = ` (${startM}/${startD}~${endM}/${endD})`;
  }

  // Part 1. 지난주 실제 업무 보고
  markdownContent += `## 📂 1. 지난주 실제 업무 보고 (Daily Work Log)${periodLabel}\n\n`;

  const logsByDate = {};
  dailyLogs.forEach(log => {
    if (!logsByDate[log.date]) logsByDate[log.date] = [];
    logsByDate[log.date].push(log);
  });

  const sortedDates = Object.keys(logsByDate).sort();

  if (sortedDates.length === 0) {
    markdownContent += `*지난주 기록된 Daily Work Log가 없습니다.*\n\n`;
  } else {
    sortedDates.forEach(date => {
      const formattedDate = formatDayLabel(date);
      markdownContent += `### ■ ${formattedDate}\n`;

      logsByDate[date].forEach(log => {
        // 일지와 연결된 Task 중 하나라도 "스마트팜 외 업무" 에 속하는지 실시간 판별
        const isOutsideWork = log.taskRelations.some(rel => {
          const taskInfo = tasksMap && tasksMap[rel.id];
          return taskInfo && taskInfo.projectName === '스마트팜 외 업무';
        });

        if (isOutsideWork) {
          // 스마트팜 외 업무는 구체적 기술 없이 축약 출력 (연동된 실제 태스크명 기재) 및 상세 생략
          const taskNames = log.taskRelations
            .map(rel => tasksMap[rel.id]?.name)
            .filter(Boolean);
          const taskNameStr = taskNames.length > 0 ? taskNames.join(', ') : '스마트팜 외 업무';
          markdownContent += `* **[${taskNameStr} (스마트팜 외 업무)](${log.url})**\n`;
        } else {
          // 일반 스마트팜 업무는 기존처럼 아주 상세하게 출력
          const cleanTitle = log.title.replace(/[📄@]/g, '').trim();
          markdownContent += `* **[${cleanTitle}](${log.url})**\n`;
          
          if (log.details && log.details.trim()) {
            const detailLines = log.details.trim().split('\n');
            detailLines.forEach(line => {
              if (line.trim()) {
                markdownContent += `  * (상세: ${line.trim()})\n`;
              }
            });
          }
        }
      });
      markdownContent += `\n`;
    });
  }

  markdownContent += `---\n\n`;

  // Part 2. 계획 대비 완료/미완료 대조 (슬랙 캔버스 전용 리치 마크다운 표)
  markdownContent += `## 📝 2. 계획 대비 완료/미완료 대조 (${weekTitle} 대조 표)\n\n`;
  markdownContent += `| ${weekTitle} 계획 | 완료여부 | ${weekTitle} Daily Work Log |\n`;
  markdownContent += `| :--- | :---: | :--- |\n`;

  analysisResults.forEach(task => {
    const cleanTaskName = task.taskName.replace(/[📄@]/g, '').trim();
    
    // 마감일자 정보가 존재할 경우 (~M/D) 라벨 생성
    let dateLabel = '';
    if (task.dueDate) {
      const dateObj = new Date(task.dueDate);
      const m = dateObj.getUTCMonth() + 1;
      const d = dateObj.getUTCDate();
      dateLabel = ` (~${m}/${d})`;
    }

    // 대분류 행: 대칭 구조 및 '-' 대조 (마감일자 포함) - 태스크 제목에 Notion Task 페이지 하이퍼링크 직접 탑재!
    const taskLink = task.taskUrl ? `[${cleanTaskName}](${task.taskUrl})` : cleanTaskName;
    markdownContent += `| 📄 **${taskLink}${dateLabel}** | **-** | 📄 **${taskLink}${dateLabel}** |\n`;

    task.subItems.forEach(sub => {
      const cleanItemName = sub.itemName.replace(/[📄@]/g, '').trim();
      const col1Val = `└ • ${cleanItemName}`;
      
      // 완료 시 ✅, 미완료 시 ❌ (x 이모티콘 배치)
      const col2Val = sub.isCompleted ? '✅' : '❌';

      let col3Val = '';
      if (sub.isCompleted && sub.matchingLog) {
        const logDate = sub.matchingLog.date;
        const dateObj = new Date(logDate);
        const formattedDate = `${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}`;
        const cleanLogTitle = sub.matchingLog.title.replace(/[📄@]/g, '').trim();
        // 캔버스 마크다운 링크 카드 연동
        col3Val = `└ • (${formattedDate}) [${cleanLogTitle}](${sub.matchingLog.url})`;
      } else if (sub.isCompleted && sub.isAlreadyChecked) {
        col3Val = `└ • (완료됨) ${cleanItemName}`;
      } else {
        // 미완료된 경우 3열은 완전히 비워둠 (공백 한 칸)
        col3Val = ' ';
      }

      markdownContent += `| ${col1Val} | ${col2Val} | ${col3Val} |\n`;
    });
  });

  markdownContent += `---\n\n`;

  // Part 3. 이번 주 업무 계획
  markdownContent += `## 🚀 3. 이번 주 업무 계획 (${nextWeekTitle})\n\n`;
  
  if (!nextWeekPlan || nextWeekPlan.length === 0) {
    markdownContent += `*이번 주 등록된 계획이 없습니다.*\n`;
  } else {
    let activeProjectName = '';

    nextWeekPlan.forEach(task => {
      const cleanTaskName = task.taskName.replace(/[📄@]/g, '').trim();
      
      // 마감일자 정보가 존재할 경우 (~M/D) 라벨 생성
      let dateLabel = '';
      if (task.dueDate) {
        const dateObj = new Date(task.dueDate);
        const m = dateObj.getUTCMonth() + 1;
        const d = dateObj.getUTCDate();
        dateLabel = ` (~${m}/${d})`;
      }

      const taskLink = task.taskUrl ? `[${cleanTaskName}](${task.taskUrl})` : cleanTaskName;

      if (task.isProjectGroup) {
        // 상위 프로젝트/그룹을 만난 경우
        activeProjectName = cleanTaskName;
        markdownContent += `### 📁 Project: ${taskLink}\n`;
        
        // 만약 상위 프로젝트 본문 자체에 하위 불릿(예: 스마트팜 외 업무 아래의 텍스트들)이 달려있다면 렌더링
        if (task.subItems && task.subItems.length > 0) {
          task.subItems.forEach(sub => {
            const cleanSubName = sub.itemName.replace(/[📄@]/g, '').trim();
            markdownContent += `* ${cleanSubName}\n`;
          });
          markdownContent += `\n`;
        }
      } else {
        // 일반 태스크를 만난 경우
        // 만약 이 태스크가 현재 활성화된 상위 프로젝트 소속이라면 계층 구조로 안착시킴!
        if (task.projectName && (task.projectName === activeProjectName || activeProjectName !== '')) {
          markdownContent += `* **Task: ${taskLink}${dateLabel}**\n`;
          
          task.subItems.forEach(sub => {
            const cleanSubName = sub.itemName.replace(/[📄@]/g, '').trim();
            const wasIncompleteLastWeek = analysisResults.some(lastTask => 
              lastTask.subItems.some(lastSub => !lastSub.isCompleted && lastSub.itemName === sub.itemName)
            );

            if (wasIncompleteLastWeek) {
              markdownContent += `  * ${cleanSubName} *(★ 지난주 미완료 이관 보완)*\n`;
            } else {
              markdownContent += `  * ${cleanSubName}\n`;
            }
          });
        } else {
          // 상위 프로젝트가 아예 없는 독립 태스크인 경우
          markdownContent += `### 🔗 Task: ${taskLink}${dateLabel}\n`;
          
          task.subItems.forEach(sub => {
            const cleanSubName = sub.itemName.replace(/[📄@]/g, '').trim();
            const wasIncompleteLastWeek = analysisResults.some(lastTask => 
              lastTask.subItems.some(lastSub => !lastSub.isCompleted && lastSub.itemName === sub.itemName)
            );

            if (wasIncompleteLastWeek) {
              markdownContent += `* ${cleanSubName} *(★ 지난주 미완료 이관 보완)*\n`;
            } else {
              markdownContent += `* ${cleanSubName}\n`;
            }
          });
          markdownContent += `\n`;
        }
      }
    });
  }

  return markdownContent;
}

/**
 * [초중요 기능] 사용자가 수동 개설한 캔버스 ID에 대해 본문 마크다운을 실시간 전체 덮어쓰기(수정)하여 갱신합니다.
 */
async function updateWeeklyReportCanvas({ canvasId, weekTitle, nextWeekTitle, memberName, analysisResults, dailyLogs, nextWeekPlan, tasksMap, startDate, endDate }) {
  try {
    const cleanMemberName = memberName.replace(' 님', '');
    const markdownContent = buildCanvasMarkdownContent({
      weekTitle,
      nextWeekTitle,
      memberName,
      analysisResults,
      dailyLogs,
      nextWeekPlan,
      tasksMap,
      startDate,
      endDate
    });

    // canvases.edit API는 권한 제약이 심하므로, 설정된 정현웅 님의 유저 토큰이 존재할 경우 유저 권한으로 실행합니다.
    const slackClient = config.slack.userToken 
      ? new WebClient(config.slack.userToken) 
      : slack;

    console.log(`  -> 수동 개설된 캔버스(${canvasId})에 '${cleanMemberName} 님'의 기존 내용 삭제(비우기) 중...`);
    
    // 캔버스 비우기
    try {
      await slackClient.apiCall('canvases.edit', {
        canvas_id: canvasId,
        changes: [
          {
            operation: 'replace',
            document_content: {
              type: 'markdown',
              markdown: ' '
            }
          }
        ]
      });
      console.log(`  -> 🎉 '${cleanMemberName} 님'의 캔버스 내용 삭제 완료!`);
    } catch (clearErr) {
      console.warn(`  -> ⚠️ 캔버스 내용 비우기 실패 (계속 진행):`, clearErr.message);
    }

    // 안전하게 1.5초 대기
    console.log(`  -> 1.5초 대기 중...`);
    await new Promise(resolve => setTimeout(resolve, 1500));

    console.log(`  -> 수동 개설된 캔버스(${canvasId})에 '${cleanMemberName} 님'의 리포트를 실시간 업데이트 중... (사용 권한: ${config.slack.userToken ? '정현웅 님 유저 권한' : 'HANSL 봇 권한'})`);

    // canvases.edit API 호출: range 없이 document_content만 전달하여 전체 영역 덮어쓰기(replace) 실행!
    // 1. 캔버스 제목(Title) 업데이트
    try {
      await slackClient.apiCall('canvases.edit', {
        canvas_id: canvasId,
        changes: [
          {
            operation: 'rename',
            title_content: {
              type: 'markdown',
              markdown: `${cleanMemberName} - ${weekTitle}`
            }
          }
        ]
      });
      console.log(`  -> 🎉 캔버스(${canvasId}) 제목 실시간 수정 완료!`);
    } catch (titleErr) {
      console.warn(`  -> ⚠️ 캔버스 제목 수정 실패 (계속 진행):`, titleErr.message);
    }

    // 2. 캔버스 본문(Content) 업데이트
    const response = await slackClient.apiCall('canvases.edit', {
      canvas_id: canvasId,
      changes: [
        {
          operation: 'replace',
          document_content: {
            type: 'markdown',
            markdown: markdownContent
          }
        }
      ]
    });

    if (response.ok) {
      console.log(`  -> 🎉 캔버스(${canvasId}) 본문 실시간 덮어쓰기(수정) 완료!`);
      
      // [신규] 깃허브 아카이브용 주간 보고서 마크다운 저장
      try {
        const reportDir = path.join(__dirname, '../../docs/weekly-reports');
        if (!fs.existsSync(reportDir)) {
          fs.mkdirSync(reportDir, { recursive: true });
        }
        const cleanMemberName = memberName.replace(' 님', '').trim();
        const safeWeekTitle = weekTitle.replace(/\s+/g, '');
        const filename = `${safeWeekTitle}_${cleanMemberName}.md`;
        const savePath = path.join(reportDir, filename);
        
        fs.writeFileSync(savePath, markdownContent, 'utf8');
        console.log(`  -> 📂 [마크다운 저장] 주간 보고서 파일 기록 성공: docs/weekly-reports/${filename}`);
      } catch (fsErr) {
        console.warn(`  -> ⚠️ 주간 보고서 파일 저장 실패 (계속 진행):`, fsErr.message);
      }

      return {
        canvasId: canvasId,
        canvasUrl: `slack://file?id=${canvasId}&team=${config.slack.teamId || 'T0B2QAU647J'}`
      };
    } else {
      throw new Error(`canvases.edit API 갱신 실패: ${JSON.stringify(response)}`);
    }
  } catch (error) {
    console.error(`캔버스(${canvasId}) 업데이트 실패:`, error.message);
    throw error;
  }
}

/**
 * 개별 직원의 주간업무 리포트 본문을 고가독성 3열 박스 격자 표 텍스트로 가공합니다 (일반 메시지용).
 */
async function buildEmployeeReportText({ weekTitle, nextWeekTitle, memberName, analysisResults, dailyLogs, nextWeekPlan, tasksMap, startDate, endDate }) {
  const cleanMemberName = memberName.replace(' 님', '');
  let text = `*👤 [담당자: ${cleanMemberName} 님 주간 업무 브리핑]*\n`;
  text += `──────────────────────────────────────\n\n`;

  let periodLabel = '';
  if (startDate && endDate) {
    const startObj = new Date(startDate);
    const endObj = new Date(endDate);
    const startM = startObj.getUTCMonth() + 1;
    const startD = startObj.getUTCDate();
    const endM = endObj.getUTCMonth() + 1;
    const endD = endObj.getUTCDate();
    periodLabel = ` (${startM}/${startD}~${endM}/${endD})`;
  }
  text += `*📂 1. 지난주 실제 업무 보고 (Daily Work Log)${periodLabel}*\n`;
  const logsByDate = {};
  dailyLogs.forEach(log => {
    if (!logsByDate[log.date]) logsByDate[log.date] = [];
    logsByDate[log.date].push(log);
  });

  const sortedDates = Object.keys(logsByDate).sort();

  if (sortedDates.length === 0) {
    text += `  _(지난주 기록된 Daily Work Log가 없습니다.)_\n\n`;
  } else {
    for (const date of sortedDates) {
      const formattedDate = formatDayLabel(date);
      text += `  *■ ${formattedDate}*\n`;
      for (const log of logsByDate[date]) {
        // 일지와 연결된 Task 중 하나라도 "스마트팜 외 업무" 에 속하는지 실시간 판별
        const isOutsideWork = log.taskRelations.some(rel => {
          const taskInfo = tasksMap && tasksMap[rel.id];
          return taskInfo && taskInfo.projectName === '스마트팜 외 업무';
        });

        if (isOutsideWork) {
          const taskNames = log.taskRelations
            .map(rel => tasksMap[rel.id]?.name)
            .filter(Boolean);
          const taskNameStr = taskNames.length > 0 ? taskNames.join(', ') : '스마트팜 외 업무';
          text += `    • <${log.url}|${taskNameStr} (스마트팜 외 업무)>\n`;
        } else {
          const cleanTitle = log.title.replace(/[📄@]/g, '').trim();
          text += `    • <${log.url}|${cleanTitle}>\n`;
          
          if (log.details && log.details.trim()) {
            const detailLines = log.details.trim().split('\n');
            for (const line of detailLines) {
              if (line.trim()) {
                const formattedLine = await formatLinksInText(line.trim());
                const cleanLineText = formattedLine.replace(/[•\-\*\s\(\)]/g, '').trim();
                if (cleanLineText.length > 0) {
                  text += `      └ (상세: ${formattedLine.trim()})\n`;
                }
              }
            }
          }
        }
      }
      text += '\n';
    }
  }

  text += `*📝 2. 계획 대비 완료/미완료 대조 (5월 4주차 대조 표)*\n`;
  text += `\`\`\`\n`;

  const col1Width = 34;
  const col2Width = 10;
  const col3Width = 46;

  text += `┌${'─'.repeat(col1Width/2)}┬${'─'.repeat(col2Width/2)}┬${'─'.repeat(col3Width/2)}┐\n`;
  text += `│${padRight(' 지난주 계획', col1Width)}│${padRight(' 완료여부', col2Width)}│${padRight(' 지난주 Daily Work Log', col3Width)}│\n`;
  text += `├${'─'.repeat(col1Width/2)}┼${'─'.repeat(col2Width/2)}┼${'─'.repeat(col3Width/2)}┤\n`;

  analysisResults.forEach(task => {
    const cleanTaskName = task.taskName.replace(/[📄@]/g, '').trim();
    const taskCol1 = cleanTaskName.length > 15 ? cleanTaskName.substring(0, 14) + '...' : cleanTaskName;
    const taskCol2 = '    -     ';
    const taskCol3 = taskCol1;

    text += `│${padRight(taskCol1, col1Width)}│${padRight(taskCol2, col2Width)}│${padRight(taskCol3, col3Width)}│\n`;

    task.subItems.forEach(sub => {
      const cleanItemName = sub.itemName.replace(/[📄@]/g, '').trim();
      const col1Val = `  └ • ${cleanItemName}`;
      const col2Val = sub.isCompleted ? '    ✅    ' : '          ';

      let col3Val = '';
      if (sub.isCompleted && sub.matchingLog) {
        const logDate = sub.matchingLog.date;
        const dateObj = new Date(logDate);
        const formattedDate = `${dateObj.getUTCMonth() + 1}/${dateObj.getUTCDate()}`;
        const cleanLogTitle = sub.matchingLog.title.replace(/[📄@]/g, '').trim();
        col3Val = `  └ • (${formattedDate}) ${cleanLogTitle}`;
      } else if (sub.isCompleted && sub.isAlreadyChecked) {
        col3Val = `  └ • (완료됨) ${cleanItemName}`;
      } else {
        col3Val = `  └ • (매칭 일지 없음 ➔ 이관)`;
      }

      const col1Trimmed = col1Val.length > 20 ? col1Val.substring(0, 19) + '...' : col1Val;
      const col3Trimmed = col3Val.length > 30 ? col3Val.substring(0, 29) + '...' : col3Val;

      text += `│${padRight(col1Trimmed, col1Width)}│${padRight(col2Val, col2Width)}│${padRight(col3Trimmed, col3Width)}│\n`;
    });

    text += `├${'─'.repeat(col1Width/2)}┼${'─'.repeat(col2Width/2)}┼${'─'.repeat(col3Width/2)}┤\n`;
  });

  text = text.trim().replace(/├───────.+┤$/, `└${'─'.repeat(col1Width/2)}┴${'─'.repeat(col2Width/2)}┴${'─'.repeat(col3Width/2)}┘`) + '\n';
  text += `\`\`\`\n\n`;

  text += `*🚀 3. 이번 주 업무 계획 (${nextWeekTitle} 계획)*\n`;
  if (!nextWeekPlan || nextWeekPlan.length === 0) {
    text += `  _(이번 주 등록된 계획이 없습니다.)_\n`;
  } else {
    nextWeekPlan.forEach(task => {
      const cleanTaskName = task.taskName.replace(/[📄@]/g, '').trim();
      const taskLink = task.taskUrl ? `<${task.taskUrl}|${cleanTaskName}>` : cleanTaskName;
      text += `  *🔗 Task: ${taskLink}*\n`;

      task.subItems.forEach(sub => {
        const cleanSubName = sub.itemName.replace(/[📄@]/g, '').trim();
        const wasIncompleteLastWeek = analysisResults.some(lastTask => 
          lastTask.subItems.some(lastSub => !lastSub.isCompleted && lastSub.itemName === sub.itemName)
        );

        if (wasIncompleteLastWeek) {
          text += `    • ${cleanSubName} _(★ 지난주 미완료 이관 보완)_\n`;
        } else {
          text += `    • ${cleanSubName}\n`;
        }
      });
    });
  }

  text += `\n\n`;
  return text;
}

async function cleanUpWeeklyReportMessages({ channelId, weekTitle }) {
  try {
    console.log(`  -> [Slack 청소] '${weekTitle}' 주간 보고 완료 알림 청소 시작...`);
    const history = await slack.conversations.history({
      channel: channelId,
      limit: 50
    });

    if (!history.ok || !history.messages) {
      console.warn('  -> [Slack 청소] 히스토리 조회 실패');
      return false;
    }

    let deleteCount = 0;
    for (const msg of history.messages) {
      const text = msg.text || '';
      const isBot = msg.bot_id;

      const isTargetReportMsg = text.includes(weekTitle) && text.includes('주간 업무 브리핑 캔버스 업데이트 완료');

      if (isBot && isTargetReportMsg) {
        try {
          await slack.chat.delete({
            channel: channelId,
            ts: msg.ts
          });
          deleteCount++;
          await new Promise(resolve => setTimeout(resolve, 800));
        } catch (delErr) {
          console.warn(`  -> [Slack 청소] 메시지 삭제 실패 (ts: ${msg.ts}):`, delErr.message);
        }
      }
    }

    console.log(`  -> 🎉 [Slack 청소] 총 ${deleteCount}개의 기존 주간 보고 메시지를 자동 삭제했습니다.`);
    return true;
  } catch (error) {
    console.error(`  -> [Slack 청소] 에러 발생:`, error.message);
    return false;
  }
}

/**
 * 모든 직원의 주간 업무 리포트를 취합하여 지정 채널에 100% 무결점 텍스트 리포트 표로 발송합니다.
 * 또한 수동 캔버스 ID 목록이 설정된 경우, 각 캔버스를 실시간 덮어쓰기(수정) 갱신해 줍니다!
 */
async function sendWeeklyReport({ weekTitle, nextWeekTitle, memberReports, targetChannelName = '스마트팜-workplan', startDate, endDate, skipChannelNotice = false }) {
  try {
    // 1. [초중요 수동 캔버스 ID 실시간 업데이트 동작]
    // config 에 캔버스 ID들이 수동 기입되어 있다면 각 캔버스를 실시간 수정(덮어쓰기)합니다.
    const updatedCanvases = [];
    for (const rep of memberReports) {
      const manualCanvasId = config.slack.canvasIds[rep.memberName];
      if (manualCanvasId) {
        if (rep.hasChanges !== false) {
          try {
            const res = await updateWeeklyReportCanvas({
              canvasId: manualCanvasId,
              weekTitle,
              nextWeekTitle,
              memberName: rep.memberName,
              analysisResults: rep.analysisResults,
              dailyLogs: rep.dailyLogs,
              nextWeekPlan: rep.nextWeekPlan,
              tasksMap: rep.tasksMap,
              startDate,
              endDate
            });
            updatedCanvases.push({
              memberName: rep.memberName,
              canvasUrl: res.canvasUrl
            });
          } catch (canvasErr) {
            console.error(`  -> '${rep.memberName}' 님의 수동 캔버스(${manualCanvasId}) 실시간 덮어쓰기 업데이트 실패:`, canvasErr.message);
          }
        } else {
          // 변동이 없는 경우, canvas 업데이트는 건너뛰고 기존 ID로 URL만 생성하여 포함
          const canvasUrl = `slack://file?id=${manualCanvasId}&team=${config.slack.teamId || 'T0B2QAU647J'}`;
          updatedCanvases.push({
            memberName: rep.memberName,
            canvasUrl
          });
          console.log(`  -> 👤 '${rep.memberName}' 님의 수동 캔버스 업데이트를 건너뜁니다 (변동 없음).`);
        }
      }
    }

    // 2. 통합 알림 채널 메시지 발송 (skipChannelNotice가 false일 때만 봇 명의로 알림 전송)
    if (!skipChannelNotice && updatedCanvases.length > 0) {
      const channelId = await findChannelIdByName(targetChannelName);
      
      // 메시지 중복 방지를 위해 기존 알림 청소
      await cleanUpWeeklyReportMessages({ channelId, weekTitle });
      
      for (let i = 0; i < updatedCanvases.length; i++) {
        const uc = updatedCanvases[i];
        const clean = uc.memberName.replace(' 님', '').trim();
        
        // 실 서비스 배포 시 <!channel> 전체 멘션이 덧붙여집니다.
        const isLast = i === updatedCanvases.length - 1;
        const channelMention = isLast ? ' <!channel>' : '';
        const noticeText = `👤 *[${clean}]* ${weekTitle} 주간 업무 브리핑 캔버스 업데이트 완료 ✅ <${uc.canvasUrl}|바로가기>${channelMention}`;

        await slack.chat.postMessage({
          channel: channelId,
          text: noticeText,
          mrkdwn: true,
          unfurl_links: false,
          unfurl_media: false
        });
        console.log(`  -> 🤖 HANSL 봇이 채널에 '${clean}'의 캔버스 바로가기 알림을 전송 완료했습니다. (마지막 멘션 여부: ${isLast})`);
      }
    } else {
      console.log(`  -> 💡 슬랙 채널 알림 메시지 발송이 옵션(skipChannelNotice)에 의해 생략되었습니다.`);
    }

    console.log(`  -> 🎉 총 ${updatedCanvases.length}명의 수동 개설 캔버스 덮어쓰기 완료!`);
    return updatedCanvases.length > 0;
  } catch (error) {
    console.error('슬랙 리포트 전송 에러:', error);
    throw error;
  }
}

async function sendDirectMessage(userId, text, blocks = null) {
  try {
    const postOptions = {
      channel: userId,
      text: text, // fallback 알림 텍스트
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false
    };
    if (blocks) {
      postOptions.blocks = blocks;
    }
    const response = await slack.chat.postMessage(postOptions);
    console.log(`  -> 🎉 HANSL 봇이 대상자(ID: ${userId})에게 1:1 DM 전송에 성공했습니다.`);
    return response;
  } catch (error) {
    console.error(`1:1 DM 발송 실패 (User ID: ${userId}):`, error.message);
    return null;
  }
}

function isImageUrl(url) {
  if (!url) return false;
  try {
    const cleanUrl = url.split(')')[0];
    const pathPart = cleanUrl.split('?')[0].toLowerCase();
    return pathPart.endsWith('.png') || 
           pathPart.endsWith('.jpg') || 
           pathPart.endsWith('.jpeg') || 
           pathPart.endsWith('.gif') || 
           pathPart.endsWith('.webp');
  } catch (e) {
    return false;
  }
}

async function formatLinksInText(text, collectImageUrls = null) {
  if (!text) return '';
  let formatted = text.trim();
  
  // 1. 마크다운 링크 [label](url) 파싱
  const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  const mdMatches = [];
  while ((match = mdRegex.exec(formatted)) !== null) {
    mdMatches.push({
      full: match[0],
      label: match[1],
      url: match[2].endsWith(')') ? match[2].slice(0, -1) : match[2]
    });
  }

  for (const m of mdMatches) {
    if (isImageUrl(m.url) || m.label.includes('이미지') || m.label.includes('사진')) {
      const shortUrl = await getPermanentImageUrl(m.url);
      if (collectImageUrls) {
        collectImageUrls.push({ url: m.url, shortUrl, label: m.label });
      }
      formatted = formatted.replace(m.full, '');
    } else {
      formatted = formatted.replace(m.full, `<${m.url}|${m.label}>`);
    }
  }
  
  // 슬랙 포맷 링크 임시 격리
  const slackLinks = [];
  formatted = formatted.replace(/<https?:\/\/[^\s>|]+\|[^>]+>/g, (match) => {
    slackLinks.push(match);
    return `__SLACK_LINK_PLACEHOLDER_${slackLinks.length - 1}__`;
  });
  formatted = formatted.replace(/<https?:\/\/[^\s>]+>/g, (match) => {
    slackLinks.push(match);
    return `__SLACK_LINK_PLACEHOLDER_${slackLinks.length - 1}__`;
  });
  
  // 2. Raw URL 파싱
  const rawUrlRegex = /<?(https?:\/\/[^\s()<>|]+)>?/g;
  const rawMatches = [];
  while ((match = rawUrlRegex.exec(formatted)) !== null) {
    rawMatches.push({
      full: match[0],
      url: match[1].endsWith(')') ? match[1].slice(0, -1) : match[1]
    });
  }

  for (const m of rawMatches) {
    if (isImageUrl(m.url)) {
      const shortUrl = await getPermanentImageUrl(m.url);
      if (collectImageUrls) {
        collectImageUrls.push({ url: m.url, shortUrl, label: '이미지 첨부' });
      }
      formatted = formatted.replace(m.full, '');
    } else {
      formatted = formatted.replace(m.full, `<${m.url}|바로가기>`);
    }
  }
  
  formatted = formatted.replace(/__SLACK_LINK_PLACEHOLDER_(\d+)__/g, (match, index) => {
    return slackLinks[parseInt(index, 10)];
  });
  
  return formatted;
}

const TECHNICAL_GLOSSARY = {
  'RealSense': 'RealSense(3D 깊이 감지 카메라)',
  'realsense': 'realsense(3D 깊이 감지 카메라)',
  'D555': 'D555(카메라 장비)',
  'Jetson': 'Jetson(인공지능 연산용 소형 컴퓨터)',
  'jetson': 'jetson(인공지능 연산용 소형 컴퓨터)',
  'DDS': 'DDS(실시간 데이터 통신 규격)',
  'DDS-enabled': 'DDS-enabled(실시간 통신이 활성화된)',
  'librealsense2': 'librealsense2(카메라 구동 라이브러리)',
  'librealsense': 'librealsense(카메라 구동 라이브러리)',
  'wrapper': 'wrapper(프로그램 연동 도구)',
  'Jumbo frame': 'Jumbo frame(대용량 네트워크 패킷 데이터)',
  'jumbo frame': 'jumbo frame(대용량 네트워크 패킷 데이터)',
  'MTU': 'MTU(네트워크 전송 최대 크기)',
  'dynamic linker': 'dynamic linker(실행 시 라이브러리 연결 도구)',
  'teleop': 'teleop(원격 조종 기능)',
  'cmd_vel': 'cmd_vel(속도 및 방향 제어 명령)',
  'MCU bridge': 'MCU bridge(제어 보드 간 신호 변환기)',
  'QoS': 'QoS(데이터 전송 품질 설정)',
  'tcpdump': 'tcpdump(네트워크 패킷 분석 도구)',
  'viewer': 'viewer(화면 모니터링 프로그램)',
  'SDK': 'SDK(소프트웨어 개발 도구)',
  'ROS2': 'ROS2(로봇 제어용 소프트웨어 플랫폼)',
  'PoE': 'PoE(랜선 전원 공급 장치)',
  'NIC': 'NIC(네트워크 카드/랜 포트)',
  'UFW': 'UFW(보안 방화벽 프로그램)',
  'firewalld': 'firewalld(보안 방화벽 프로그램)',
  'docker': 'docker(개발 가상 컨테이너)',
  'Docker': 'Docker(개발 가상 컨테이너)',
  'topic': 'topic(ROS2 통신 채널)',
  'topics': 'topics(ROS2 통신 채널들)',
  'ldconfig': 'ldconfig(라이브러리 경로 갱신 도구)',
  'ping': 'ping(네트워크 연결 확인 신호)',
  'wheel': 'wheel(파이썬 패키지 설치용 파일)',
  'ARM64': 'ARM64(소형 컴퓨터용 프로세서 규격)',
  'aarch64': 'aarch64(소형 컴퓨터용 프로세서 규격)',
  'CMakeCache.txt': 'CMakeCache.txt(빌드 설정 파일)',
  'build-local': 'build-local(로컬 컴퓨터 자체 빌드)',
  'realsense2_camera': 'realsense2_camera(ROS2 카메라 드라이버)'
};

function applyGlossaryFilter(text) {
  if (!text) return '';
  let result = text;
  
  // 키의 길이 역순으로 정렬하여 긴 키워드부터 치환 적용
  const sortedKeys = Object.keys(TECHNICAL_GLOSSARY).sort((a, b) => b.length - a.length);
  
  for (const key of sortedKeys) {
    const value = TECHNICAL_GLOSSARY[key];
    const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    
    // 이미 괄호 설명이 붙어 있는 경우는 중복 처리를 방지하기 위해 룩어헤드 적용.
    // \b 대신 (?<![\w-])와 (?![\w-])를 적용하여 DDS가 DDS-enabled 내부에서 오치환되는 것을 방지합니다.
    // 괄호 앞의 공백도 허용하도록 (?!\s*\()를 사용하여 중복 치환을 예방합니다.
    const regex = new RegExp(`(?<![\\w-])${escapedKey}(?![\\w-])(?!\\s*\\()`, 'g');
    result = result.replace(regex, value);
  }
  
  return result;
}

/**
 * 일지 본문에서 목적, 의미, 개요 등의 핵심 문장을 추출하여 직관적인 요약 코너를 빌드합니다.
 */
function buildDailySummarySection(memberReports, date = null) {
  const dateLabel = date ? formatDayLabel(date) : '오늘';
  let summary = `## 📢 ${dateLabel} 업무 요약 브리핑\n\n`;
  summary += `> 각 팀원들의 금일 업무 목적 및 진행 의미 요약입니다.\n\n`;
  
  let hasAnyLog = false;
  
  for (const rep of memberReports) {
    const cleanName = rep.memberName.replace(' 님', '').trim();
    if (!rep.dailyLogs || rep.dailyLogs.length === 0) continue;
    
    hasAnyLog = true;
    summary += `### 👤 ${cleanName} 님\n`;
    
    for (const log of rep.dailyLogs) {
      const cleanTitle = log.title ? log.title.replace(/[📄@]/g, '').trim() : '제목 없음';
      let purpose = '';
      let meaning = '';
      let overview = '';
      
      if (log.details) {
        const lines = log.details.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          // 상세: 목적: ... / 상세: 진행 의미: ... 등 파싱
          const purposeMatch = trimmed.match(/(?:목적|상세:\s*목적)\s*:\s*(.*)/i);
          const meaningMatch = trimmed.match(/(?:진행\s*의미|진행의미|의미|상세:\s*진행\s*의미|상세:\s*진행의미|상세:\s*의미)\s*:\s*(.*)/i);
          const overviewMatch = trimmed.match(/(?:개요|상세:\s*개요)\s*:\s*(.*)/i);
          
          if (purposeMatch) purpose = purposeMatch[1].replace(/\)$/, '').trim();
          if (meaningMatch) meaning = meaningMatch[1].replace(/\)$/, '').trim();
          if (overviewMatch) overview = overviewMatch[1].replace(/\)$/, '').trim();
        }
      }
      
      if (overview) {
        summary += `* **${cleanTitle}**\n  - *개요*: ${overview}\n`;
      } else if (purpose || meaning) {
        summary += `* **${cleanTitle}**\n`;
        if (purpose) summary += `  - *목적*: ${purpose}\n`;
        if (meaning) summary += `  - *진행 의미*: ${meaning}\n`;
      } else {
        let fallbackText = '';
        if (log.details) {
          const firstLine = log.details.split('\n')
            .map(l => l.trim())
            .find(l => l.length > 0 && !l.includes('작업 내용') && !l.includes('개요'));
          if (firstLine) {
            fallbackText = firstLine.replace(/^[•\-\*\s◦▪▫▶▷·⁃\(\)상세:]+/, '').trim();
          }
        }
        summary += `* **${cleanTitle}**${fallbackText ? `\n  - *상세*: ${fallbackText}` : ''}\n`;
      }
    }
    summary += `\n`;
  }
  
  return hasAnyLog ? applyGlossaryFilter(summary) : '';
}

async function buildDailyReportMarkdown({ date, memberReports }) {
  try {
    const dayLabel = formatDayLabel(date);
    
    // Supabase에서 승인된 출장자 및 휴가자 정보 조회
    const approvedTrips = await supabaseService.getApprovedBusinessTrips(date);
    const approvedLeaves = await supabaseService.getApprovedLeaves(date);

    let dailyArchiveContent = `# 📅 일일 업무 보고 브리핑 (${dayLabel})\n\n`;
    dailyArchiveContent += `> 당일 팀원들의 Notion Daily Work Log 취합 요약 브리핑 히스토리입니다.\n\n---\n\n`;

    for (const rep of memberReports) {
      const cleanName = rep.memberName.replace(' 님', '').trim();
      const memberEmail = MEMBER_EMAILS[cleanName];
      const tripInfo = approvedTrips.get(cleanName);
      const isTripFromSupabase = !!tripInfo;
      const isSmartFarmTrip = tripInfo ? tripInfo.isSmartFarm : false;
      const leaveTypeFromSupabase = memberEmail ? approvedLeaves[memberEmail.trim().toLowerCase()] : null;

      let statusLabel = '';
      if (leaveTypeFromSupabase) {
        statusLabel = ` - ${leaveTypeFromSupabase}`;
      } else if (isTripFromSupabase) {
        statusLabel = isSmartFarmTrip ? ' - 출장(스마트팜)' : ' - 출장(스마트팜 외)';
      } else if (rep.dailyLogs && rep.dailyLogs.length > 0) {
        let hasVacation = false;
        let hasMorningHalf = false;
        let hasAfternoonHalf = false;
        let hasHalfDay = false;
        let hasBusinessTrip = false;

        rep.dailyLogs.forEach(log => {
          const t = log.title || '';
          if (t.includes('오전반차') || t.includes('오전 반차')) {
            hasMorningHalf = true;
          } else if (t.includes('오후반차') || t.includes('오후 반차')) {
            hasAfternoonHalf = true;
          } else if (t.includes('반차')) {
            hasHalfDay = true;
          } else if (t.includes('연차')) {
            hasVacation = true;
          } else if (t.includes('출장')) {
            hasBusinessTrip = true;
          }
        });

        if (hasVacation) statusLabel = ' - 연차';
        else if (hasMorningHalf) statusLabel = ' - 오전반차';
        else if (hasAfternoonHalf) statusLabel = ' - 오후반차';
        else if (hasHalfDay) statusLabel = ' - 반차';
        else if (hasBusinessTrip) statusLabel = ' - 출장';
      }

      dailyArchiveContent += `## 👤 ${cleanName} 님${statusLabel}\n\n`;

      if (!rep.dailyLogs || rep.dailyLogs.length === 0) {
        let emptyText = '* _오늘 기록된 일일 업무 일지가 없습니다._';
        if (leaveTypeFromSupabase) {
          emptyText = `* _금일 ${leaveTypeFromSupabase}입니다._`;
        } else if (isTripFromSupabase && !isSmartFarmTrip) {
          emptyText = '* _금일 출장(스마트팜 외)입니다._';
        }
        dailyArchiveContent += `${emptyText}\n\n`;
      } else {
        for (const log of rep.dailyLogs) {
          const isOutsideWork = 
            (log.title && log.title.includes('스마트팜 외 업무')) ||
            log.taskRelations.some(rel => {
              const taskInfo = rep.tasksMap && rep.tasksMap[rel.id];
              return taskInfo && (
                taskInfo.projectName === '스마트팜 외 업무' ||
                taskInfo.name === '스마트팜 외 업무' ||
                (taskInfo.name && taskInfo.name.includes('스마트팜 외 업무'))
              );
            });

          if (isOutsideWork) {
            const taskNames = log.taskRelations
              .map(rel => rep.tasksMap[rel.id]?.name)
              .filter(Boolean);
            const taskNameStr = taskNames.length > 0 ? taskNames.join(', ') : '스마트팜 외 업무';
            
            dailyArchiveContent += `* **[${taskNameStr} (스마트팜 외 업무)](${log.url})**\n\n`;
          } else {
            const cleanTitle = log.title.replace(/[📄@]/g, '').trim();
            dailyArchiveContent += `* **[${cleanTitle}](${log.url})**\n`;

            const logImages = [];
            if (log.details && log.details.trim()) {
              const detailLines = log.details.trim().split('\n');
              for (const line of detailLines) {
                if (line.trim()) {
                  const lineImages = [];
                  const formattedLine = await formatLinksInText(line.trim(), lineImages);

                  const cleanLineText = formattedLine.replace(/[•\-\*\s\(\)]/g, '').trim();
                  if (cleanLineText.length > 0) {
                    dailyArchiveContent += `  - (상세: ${formattedLine.trim()})\n`;
                  }
                  if (lineImages.length > 0) {
                    for (const img of lineImages) {
                      logImages.push(img);
                    }
                  }
                }
              }
            }

            for (const img of logImages) {
              const shortUrl = img.shortUrl || await getPermanentImageUrl(img.url);
              dailyArchiveContent += `\n![${img.label || '이미지 첨부'}](${shortUrl})\n`;
            }
            dailyArchiveContent += `\n`;
          }
        }
      }
      dailyArchiveContent += `\n---\n\n`;
    }

    // [신규] 오늘의 업무 요약본 추가
    const summarySection = buildDailySummarySection(memberReports, date);
    if (summarySection) {
      dailyArchiveContent += summarySection;
    }

    return dailyArchiveContent;
  } catch (error) {
    console.error('[Slack Service] 일일 마크다운 생성 실패:', error.message);
    return '';
  }
}

async function cleanUpDailyReportMessages({ channelId, date }) {
  try {
    const dayLabel = formatDayLabel(date);
    console.log(`  -> [Slack 청소] '${dayLabel}' 일일 보고 메시지 청소 시작 (채널 ID: ${channelId})...`);

    // 1. 채널의 히스토리 조회 (최대 100개)
    const history = await slack.conversations.history({
      channel: channelId,
      limit: 100
    });

    if (!history.ok || !history.messages) {
      console.warn('  -> [Slack 청소] 히스토리 조회 실패');
      return false;
    }

    let deleteCount = 0;
    for (const msg of history.messages) {
      const text = msg.text || '';
      const isBot = msg.bot_id;

      const isTargetReportMsg =
        text.includes(dayLabel) ||
        (msg.blocks && JSON.stringify(msg.blocks).includes(dayLabel));

      if (isBot && isTargetReportMsg) {
        try {
          await slack.chat.delete({
            channel: channelId,
            ts: msg.ts
          });
          deleteCount++;
          await new Promise(resolve => setTimeout(resolve, 800)); // 레이트 리밋 방지
        } catch (delErr) {
          console.warn(`  -> [Slack 청소] 메시지 삭제 실패 (ts: ${msg.ts}):`, delErr.message);
        }
      }
    }

    console.log(`  -> 🎉 [Slack 청소] 총 ${deleteCount}개의 기존 일일 보고 메시지를 자동 삭제했습니다.`);
    return true;
  } catch (error) {
    console.error(`  -> [Slack 청소] 에러 발생:`, error.message);
    return false;
  }
}

async function sendDailyReport({ date, memberReports, targetChannelName = '일일업무보고' }) {
  try {
    const channelId = await findChannelIdByName(targetChannelName);
    
    // 메시지 발송 전에 기존 메시지를 먼저 싹 지웁니다.
    await cleanUpDailyReportMessages({ channelId, date });

    const dayLabel = formatDayLabel(date);
    
    // Supabase에서 승인된 출장자 및 휴가자 정보 조회
    const approvedTrips = await supabaseService.getApprovedBusinessTrips(date);
    const approvedLeaves = await supabaseService.getApprovedLeaves(date);
    
    // 1. 공통 헤더 메시지 발송
    let headerText = `📢 *[일일 업무 보고 브리핑]* (${dayLabel})\n`;
    headerText += `> 당일 팀원들의 Notion Daily Work Log 취합 요약 브리핑입니다.\n\n`;
    headerText += `---`;
    
    await slack.chat.postMessage({
      channel: channelId,
      text: headerText,
      mrkdwn: true,
      unfurl_links: false
    });
    await new Promise(resolve => setTimeout(resolve, 1500));

    // [신규] 깃허브 아카이브용 일일 취합 마크다운 빌더 시작
    let dailyArchiveContent = `# 📅 일일 업무 보고 브리핑 (${dayLabel})\n\n`;
    dailyArchiveContent += `> 당일 팀원들의 Notion Daily Work Log 취합 요약 브리핑 히스토리입니다.\n\n---\n\n`;

    // 2. 담당자별로 일지 단위 메시지 전송 (한슬 토글 최적화 및 50개 블록 제한 원천 차단)
    for (const rep of memberReports) {
      const cleanName = rep.memberName.replace(' 님', '').trim();
      const memberEmail = MEMBER_EMAILS[cleanName];
      const tripInfo = approvedTrips.get(cleanName);
      const isTripFromSupabase = !!tripInfo;
      const isSmartFarmTrip = tripInfo ? tripInfo.isSmartFarm : false;
      const leaveTypeFromSupabase = memberEmail ? approvedLeaves[memberEmail.trim().toLowerCase()] : null;

      let statusLabel = '';
      if (leaveTypeFromSupabase) {
        statusLabel = ` - ${leaveTypeFromSupabase}`;
      } else if (isTripFromSupabase) {
        statusLabel = isSmartFarmTrip ? ' - 출장(스마트팜)' : ' - 출장(스마트팜 외)';
      } else if (rep.dailyLogs && rep.dailyLogs.length > 0) {
        let hasVacation = false;
        let hasMorningHalf = false;
        let hasAfternoonHalf = false;
        let hasHalfDay = false;
        let hasBusinessTrip = false;

        rep.dailyLogs.forEach(log => {
          const t = log.title || '';
          if (t.includes('오전반차') || t.includes('오전 반차')) {
            hasMorningHalf = true;
          } else if (t.includes('오후반차') || t.includes('오후 반차')) {
            hasAfternoonHalf = true;
          } else if (t.includes('반차')) {
            hasHalfDay = true;
          } else if (t.includes('연차')) {
            hasVacation = true;
          } else if (t.includes('출장')) {
            hasBusinessTrip = true;
          }
        });

        if (hasVacation) statusLabel = ' - 연차';
        else if (hasMorningHalf) statusLabel = ' - 오전반차';
        else if (hasAfternoonHalf) statusLabel = ' - 오후반차';
        else if (hasHalfDay) statusLabel = ' - 반차';
        else if (hasBusinessTrip) statusLabel = ' - 출장';
      }

      dailyArchiveContent += `## 👤 ${cleanName} 님${statusLabel}\n\n`;

      const memberBlocks = [];
      
      // 담당자 헤더 블록 추가
      memberBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `👤 *${cleanName} 님${statusLabel}* - _(${dayLabel})_`
        }
      });

      if (!rep.dailyLogs || rep.dailyLogs.length === 0) {
        let emptyText = '* _오늘 기록된 일일 업무 일지가 없습니다._';
        if (leaveTypeFromSupabase) {
          emptyText = `* _금일 ${leaveTypeFromSupabase}입니다._`;
        } else if (isTripFromSupabase && !isSmartFarmTrip) {
          emptyText = '* _금일 출장(스마트팜 외)입니다._';
        }
        dailyArchiveContent += `${emptyText}\n\n`;
        
        memberBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: emptyText
          }
        });
      } else {
        for (const log of rep.dailyLogs) {
          const isOutsideWork = 
            (log.title && log.title.includes('스마트팜 외 업무')) ||
            log.taskRelations.some(rel => {
              const taskInfo = rep.tasksMap && rep.tasksMap[rel.id];
              return taskInfo && (
                taskInfo.projectName === '스마트팜 외 업무' ||
                taskInfo.name === '스마트팜 외 업무' ||
                (taskInfo.name && taskInfo.name.includes('스마트팜 외 업무'))
              );
            });

          if (isOutsideWork) {
            const taskNames = log.taskRelations
              .map(rel => rep.tasksMap[rel.id]?.name)
              .filter(Boolean);
            const taskNameStr = taskNames.length > 0 ? taskNames.join(', ') : '스마트팜 외 업무';
            
            dailyArchiveContent += `* **[${taskNameStr} (스마트팜 외 업무)](${log.url})**\n\n`;

            memberBlocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `• <${log.url}|*${taskNameStr} (스마트팜 외 업무)*>`
              }
            });
          } else {
            const cleanTitle = log.title.replace(/[📄@]/g, '').trim();
            dailyArchiveContent += `* **[${cleanTitle}](${log.url})**\n`;

            let logItemText = `• <${log.url}|*${cleanTitle}*>\n`;
            const logImages = [];

            if (log.details && log.details.trim()) {
              const detailLines = log.details.trim().split('\n');
              for (const line of detailLines) {
                if (line.trim()) {
                  const lineImages = [];
                  const formattedLine = await formatLinksInText(line.trim(), lineImages);

                  // 이미지 링크가 제거된 후 남은 텍스트가 유의미하지 않다면 본문 추가를 스킵
                  const cleanLineText = formattedLine.replace(/[•\-\*\s\(\)]/g, '').trim();
                  if (cleanLineText.length === 0) {
                    if (lineImages.length > 0) {
                      for (const img of lineImages) {
                        logImages.push(img);
                      }
                    }
                  } else {
                    dailyArchiveContent += `  - (상세: ${formattedLine.trim()})\n`;
                    
                    // 글자수 제한 체크 (3000자 초과 방지)
                    const appendStr = `  - (상세: ${formattedLine.trim()})\n`;
                    if (logItemText.length + appendStr.length > 2800) {
                      const limitNotice = `\n... (본문이 너무 길어 생략되었습니다. 전체 내용은 노션 링크에서 확인해주세요.)\n`;
                      if (!logItemText.includes(limitNotice)) {
                        logItemText += limitNotice;
                      }
                    } else {
                      logItemText += appendStr;
                    }

                    if (lineImages.length > 0) {
                      for (const img of lineImages) {
                        logImages.push(img);
                      }
                    }
                  }
                }
              }
            }

            memberBlocks.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: logItemText
              }
            });

            // 이미지가 존재하는 경우 본문 바로 밑에 image 블록을 배치
            for (const img of logImages) {
              const shortUrl = img.shortUrl || await getPermanentImageUrl(img.url);
              
              // 깃허브 아카이브용 마크다운에도 이미지 렌더링 태그 추가
              dailyArchiveContent += `\n![${img.label || '이미지 첨부'}](${shortUrl})\n`;

              memberBlocks.push({
                type: 'image',
                image_url: shortUrl,
                alt_text: img.label || '이미지 첨부'
              });
            }
            dailyArchiveContent += `\n`;
          }
        }
      }

      dailyArchiveContent += `\n---\n\n`;

      // 담당자당 단 1개의 통합 메시지로 전송!
      await slack.chat.postMessage({
        channel: channelId,
        text: `👤 ${cleanName} 님 일일 업무 보고 - (${dayLabel})`,
        blocks: memberBlocks,
        unfurl_links: false
      });
      await new Promise(resolve => setTimeout(resolve, 1500)); // 레이트 리밋 방지
      console.log(`  -> 🎉 '${cleanName} 님'의 일일 보고 통합 메시지 발송 완료!`);
    }

    // [신규] 오늘의 업무 요약본 추가
    const summarySection = buildDailySummarySection(memberReports, date);
    if (summarySection) {
      dailyArchiveContent += summarySection;
    }

    // [신규] 깃허브 아카이브용 일일 보고서 마크다운 저장
    try {
      const reportDir = path.join(__dirname, '../../docs/daily-reports');
      if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir, { recursive: true });
      }
      const filename = `${date}.md`;
      const savePath = path.join(reportDir, filename);
      
      fs.writeFileSync(savePath, dailyArchiveContent, 'utf8');
      console.log(`  -> 📂 [마크다운 저장] 일일 보고서 파일 기록 성공: docs/daily-reports/${filename}`);
    } catch (fsErr) {
      console.warn(`  -> ⚠️ 일일 보고서 파일 저장 실패 (계속 진행):`, fsErr.message);
    }

    // [신규] 오늘의 업무 요약본을 채널로 추가 전송
    try {
      const slackSummary = buildDailySummarySection(memberReports, date);
      if (slackSummary) {
        // 슬랙 마크다운 문법에 맞춰 제목과 인용구 보정
        let formattedSlackSummary = slackSummary
          .replace(/## 📢 (.*) 업무 요약 브리핑/g, '📢 *[$1 업무 요약 브리핑]*')
          .replace(/> 각 팀원들의 금일 업무 목적 및 진행 의미 요약입니다\./g, '')
          .replace(/### 👤 (.*) 님/g, '👤 *$1 님*');

        // GFM bullet + bold 문법 `* **제목**` -> 슬랙의 `• *제목*` 으로 보정
        formattedSlackSummary = formattedSlackSummary.replace(/^\*\s+\*\*([^*]+)\*\*/gm, '• *$1*');

        // GFM sub-bullet + italic 문법 `  - *라벨*: ` -> 슬랙의 `  - _라벨_: ` 으로 보정
        formattedSlackSummary = formattedSlackSummary.replace(/^\s+-\s+\*([^*]+)\*:/gm, '  - _$1_:');

        formattedSlackSummary = formattedSlackSummary
          .replace(/\n\n\n/g, '\n\n')
          .trim();

        await slack.chat.postMessage({
          channel: channelId,
          text: formattedSlackSummary,
          mrkdwn: true,
          unfurl_links: false
        });
        console.log(`  -> 🎉 오늘의 업무 요약 브리핑을 채널로 추가 전송 완료!`);
      }
    } catch (summaryErr) {
      console.error(`  -> ❌ 슬랙 요약 브리핑 전송 중 오류:`, summaryErr.message);
    }

    return true;
  } catch (error) {
    console.error('일일 업무 브리핑 채널 전송 실패:', error.message);
    return false;
  }
}

async function findUserIdByEmail(email) {
  const cleanEmail = email.trim().toLowerCase();
  if (userIdCache[cleanEmail]) {
    return userIdCache[cleanEmail];
  }
  try {
    const response = await slack.users.lookupByEmail({ email: cleanEmail });
    if (response.ok && response.user?.id) {
      userIdCache[cleanEmail] = response.user.id;
      return response.user.id;
    }
  } catch (error) {
    console.error(`[Slack] 이메일 기준 유저 ID 조회 실패 (${cleanEmail}):`, error.message);
  }
  return null;
}

async function sendChannelReminder({ mentionIds, targetChannelName = '스마트팜-workplan' }) {
  try {
    if (!mentionIds || mentionIds.length === 0) {
      console.log(`[Slack] 독려 대상자가 없어 채널 메시지 발송을 생략합니다.`);
      return false;
    }

    const channelId = await findChannelIdByName(targetChannelName);
    const mentionsText = mentionIds.map(id => `<@${id}>`).join(' ');
    const messageText = `금일 데일리 워크로그 작성 부탁드립니다! ${mentionsText}`;

    await slack.chat.postMessage({
      channel: channelId,
      text: messageText,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false
    });

    console.log(`  -> 🎉 슬랙 채널(#${targetChannelName})로 일지 작성 독려 메시지 전송 성공! (멘션 대상: ${mentionIds.join(', ')})`);
    return true;
  } catch (error) {
    console.error(`[Slack] 채널 독려 메시지 전송 실패:`, error.message);
    return false;
  }
}

async function sendProjectCompletedNotification({ projectName, projectUrl, pmName, targetChannelName = '스마트팜-workplan' }) {
  try {
    const channelId = await findChannelIdByName(targetChannelName);
    const text = `🎉 *[프로젝트 완료 자동 전환]*\n진행률이 100%에 도달하여 프로젝트가 자동으로 완료 처리되었습니다!\n*프로젝트명*: <${projectUrl}|${projectName}>\n*담당자(PM)*: ${pmName}`;
    
    await slack.chat.postMessage({
      channel: channelId,
      text: text,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false
    });
    console.log(`  -> 🎉 슬랙에 프로젝트 완료 알림 발송 완료: ${projectName} (담당자: ${pmName})`);
  } catch (error) {
    console.error('슬랙 프로젝트 완료 알림 전송 실패:', error.message);
  }
}

async function sendOverdueTasksReminder({ memberName, position, tasks }) {
  try {
    const email = MEMBER_EMAILS[memberName];
    if (!email) {
      console.warn(`[지연 알림] '${memberName}' 님의 이메일 정보(MEMBER_EMAILS)를 찾지 못해 DM 발송을 생략합니다.`);
      return false;
    }
    const userId = await findUserIdByEmail(email);
    if (!userId) {
      console.warn(`[지연 알림] '${memberName}' 님의 슬랙 ID를 찾지 못해 DM 발송을 생략합니다.`);
      return false;
    }

    // 마감일 기준 정렬하여 가장 오래된 마감일을 대표 종료일로 MM/DD 표기
    const sortedTasks = [...tasks].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const oldestDueDate = sortedTasks[0]?.dueDate || '';
    let formattedDateLabel = '';
    if (oldestDueDate) {
      const match = oldestDueDate.match(/-\d{2}-(\d{2})/);
      const monthMatch = oldestDueDate.match(/-(\d{2})-/);
      if (monthMatch && match) {
        const m = parseInt(monthMatch[1], 10);
        const d = parseInt(match[1], 10);
        formattedDateLabel = `(${m}/${d})`;
      }
    }

    let text = `안녕하세요 ${memberName} ${position}님 🙂\n`;
    text += `담당하신 태스크 중 종료일${formattedDateLabel}이 지났는데 아직 "🚀 진행 중"으로 남아 있는 항목이 ${tasks.length}건 있어 확인 부탁드립니다.\n`;
    text += `각 항목별로, 완료된 건은 "✅ 완료"로 변경해주시고 / 아직 진행 중이면 종료일자를 연장해주세요.\n\n`;

    sortedTasks.forEach(task => {
      text += `D+${task.delayDays} ${task.title} — ${task.projectName}\n`;
    });

    text += `\n확인 후 업데이트 부탁드립니다. 감사합니다!`;

    await sendDirectMessage(userId, text);
    console.log(`  -> 🎉 '${memberName} ${position}'님에게 지연 태스크 독려 DM 발송 성공 (태스크 ${tasks.length}건)`);
    return true;
  } catch (error) {
    console.error(`sendOverdueTasksReminder 에러 (${memberName}):`, error.message);
    return false;
  }
}

module.exports = {
  findChannelIdByName,
  sendWeeklyReport,
  sendDirectMessage,
  sendDailyReport,
  findUserIdByEmail,
  sendChannelReminder,
  MEMBER_EMAILS,
  buildDailyReportMarkdown,
  cleanUpDailyReportMessages,
  sendProjectCompletedNotification,
  sendOverdueTasksReminder,
  buildCanvasMarkdownContent
};
