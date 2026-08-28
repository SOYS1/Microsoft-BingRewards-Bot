// ==UserScript==
// @name         Microsoft Bing Rewards 自动搜索助手
// @name:en      Microsoft BingRewards Bot
// @namespace    SOYS
// @version      1.1.3
// @description  自动完成 Microsoft Rewards 在必应（Bing）上的每日搜索任务，支持自动点击奖励卡片、自定义搜索速度（默认已优化，不建议修改）。可配置UI界面，模拟人工操作提高安全性，全自动完成电脑端90分任务。
// @description:en  Automatically completes Microsoft Rewards daily search tasks on Bing. Supports auto-clicking reward cards and customizable speed (defaults are optimal, not recommended to change). Configurable UI with human-like behavior for better safety. Full auto 90-point completion.
// @author       SOYS
// @match        *://*.bing.com/*
// @grant        none
// @run-at       document-end
// @license      MIT
// @icon         https://www.bing.com/favicon.ico
// @downloadURL https://greasyfork.org/zh-CN/scripts/592417
// @updateURL https://greasyfork.org/scripts/592417.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // skip running inside iframes (e.g. rewards sidebar)
    if (window !== window.top) return;

    // 存储搜索词和当前进度
    let mainPageSearchTerms = []; // 主页面搜索词
    let iframeSearchTerms = []; // iframe搜索词
    let usedSearchTerms = new Set(); // 已使用的搜索词
    let dailyTasksData = []; // 每日点击任务数据
    let currentProgress = {
        current: 0,
        total: 0,
        completed: false, // 任务是否已完成
        noProgressCount: 0 // 连续未增加进度的次数
    };
    let isSearching = false;
    let countdownTimer = null;
    let scrollIntervalId = null;

    // 保底搜索词
    const fallbackSearchTerms = [
        'iPhone', 'Tesla', 'NVIDIA', 'Microsoft', 'weather', 'news today',
        'best movies', 'recipe', 'travel', 'technology', 'sports scores',
        'stock market', 'music playlist', 'fitness tips', 'book reviews'
    ];

    // 配置参数
    const config = {
        restTime: 5 * 60, // 无进度时休息时间（秒）
        scrollTime: 10, // 滚动时间（秒）
        waitTime: 10, // 获取进度后等待时间（秒）
        searchInterval: [5, 10], // 搜索间隔范围（秒）
        maxNoProgressCount: 3, // 连续多少次不增加分数才休息
        autoClickDailyTasks: true // 自动点击每日奖励卡片
    };

    // 工作状态
    const searchState = {
        currentAction: 'idle', // 当前动作：idle, searching, scrolling, checking, waiting, resting
        countdown: 0, // 倒计时
        needRest: false, // 是否需要休息
        isCollapsed: true // UI默认折叠
    };

    // DOM元素缓存
    const domCache = {};
    function cacheDomElements() {
        ['rewards-progress', 'search-status', 'countdown', 'start-search-btn',
         'rewards-search-terms-container', 'rewards-config-section', 'daily-tasks-section',
         'daily-tasks-list', 'daily-tasks-summary', 'main-search-terms', 'iframe-search-terms',
         'rewards-helper-content', 'rewards-helper-container', 'minimize-btn', 'panel-body', 'capsule-btn', 'status-dot-capsule'].forEach(id => {
            domCache[id] = document.getElementById(id);
        });
    }

    // 本地存储键名
    const STORAGE_KEY = 'bing_rewards_auto_searcher_state';
    const CONFIG_STORAGE_KEY = 'bing_rewards_config';

    // detect dark mode - prioritize Bing's own setting over system
    function isDarkMode() {
        const html = document.documentElement;
        if (html.classList.contains('b_dark')) return true;
        if (document.body && document.body.classList.contains('b_dark')) return true;
        if (html.getAttribute('data-darkmode') === 'true') return true;
        if (document.body) return false;
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    // color theme
    function getTheme() {
        const dark = isDarkMode();
        return {
            bg: dark ? '#2d2d2d' : '#fff',
            border: dark ? '#444' : '#ddd',
            text: dark ? '#e0e0e0' : '#333',
            textSecondary: dark ? '#aaa' : '#666',
            inputBg: dark ? '#3a3a3a' : '#fff',
            inputBorder: dark ? '#555' : '#ccc',
            accent: '#0078d4',
            accentDanger: '#d83b01',
        };
    }

    // save config to localStorage
    function saveConfig() {
        try {
            localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({
                restTime: config.restTime,
                scrollTime: config.scrollTime,
                waitTime: config.waitTime,
                maxNoProgressCount: config.maxNoProgressCount,
                searchInterval: config.searchInterval,
                autoClickDailyTasks: config.autoClickDailyTasks
            }));
        } catch (e) { /* ignore */ }
    }

    // load config from localStorage
    function loadConfig() {
        try {
            const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
            if (saved) {
                const c = JSON.parse(saved);
                if (c.restTime) config.restTime = c.restTime;
                if (c.scrollTime) config.scrollTime = c.scrollTime;
                if (c.waitTime) config.waitTime = c.waitTime;
                if (c.maxNoProgressCount) config.maxNoProgressCount = c.maxNoProgressCount;
                if (Array.isArray(c.searchInterval) && c.searchInterval.length === 2 &&
                    typeof c.searchInterval[0] === 'number' && typeof c.searchInterval[1] === 'number' &&
                    c.searchInterval[0] >= 1 && c.searchInterval[0] <= c.searchInterval[1]) {
                    config.searchInterval = c.searchInterval;
                }
                if (typeof c.autoClickDailyTasks === 'boolean') {
                    config.autoClickDailyTasks = c.autoClickDailyTasks;
                }
            }
        } catch (e) { /* ignore */ }
    }

    // load saved config on startup
    loadConfig();

    // ==================== 网络请求拦截器 ====================
    // 用于捕获 Bing Rewards API 响应，绕过跨域 iframe 限制
    const interceptedRewardsData = {
        progress: null,
        dailyTasks: [],
        searchTerms: []
    };

    function interceptNetworkRequests() {
        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const url = args[0];
            const options = args[1] || {};
            try {
                const response = await originalFetch.apply(this, args);
                const clone = response.clone();
                clone.text().then(text => {
                    parseRewardsResponse(url, text);
                }).catch(() => {});
                return response;
            } catch (e) {
                return Promise.reject(e);
            }
        };

        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalXHRSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this._method = method;
            this._url = url;
            return originalXHROpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.send = function (body) {
            const xhr = this;
            xhr.addEventListener('load', function () {
                try { parseRewardsResponse(xhr._url, xhr.responseText); } catch (e) {}
            });
            return originalXHRSend.apply(this, [body]);
        };

        console.log('[RewardsHelper] 网络拦截器已激活');
    }

    function parseRewardsResponse(url, text) {
        if (!text || text.length < 100) return;

        const progressMatch = text.match(/\{"current":(\d+),"total":(\d+)/);
        if (progressMatch) {
            interceptedRewardsData.progress = {
                current: parseInt(progressMatch[1]),
                total: parseInt(progressMatch[2])
            };
            console.log('[RewardsHelper] 从API捕获进度:', interceptedRewardsData.progress);
            updateProgressFromData(interceptedRewardsData.progress);
            return;
        }

        const progressTextMatch = text.match(/(\d+)\/(\d+)/);
        if (progressTextMatch) {
            const current = parseInt(progressTextMatch[1]);
            const total = parseInt(progressTextMatch[2]);
            if (current <= total && total <= 100) {
                interceptedRewardsData.progress = { current, total };
                console.log('[RewardsHelper] 从文本捕获进度:', interceptedRewardsData.progress);
                updateProgressFromData(interceptedRewardsData.progress);
            }
        }

        if (text.includes('offer') && text.includes('completed')) {
            const tasks = [];
            const taskMatches = text.match(/"title":"([^"]+)".*"status":"(completed|in_progress)"/g);
            if (taskMatches) {
                taskMatches.forEach(match => {
                    const titleMatch = match.match(/"title":"([^"]+)"/);
                    const statusMatch = match.match(/"status":"(completed|in_progress)"/);
                    if (titleMatch && statusMatch) {
                        tasks.push({
                            name: titleMatch[1],
                            status: statusMatch[1] === 'completed' ? '已完成' : '未完成'
                        });
                    }
                });
            }
            if (tasks.length > 0) {
                interceptedRewardsData.dailyTasks = tasks;
                console.log('[RewardsHelper] 从API捕获每日任务:', tasks.length, '个');
                updateDailyTasksUI(tasks);
            }
        }
    }

    function updateProgressFromData(progress) {
        if (progress && progress.current !== undefined && progress.total !== undefined) {
            const oldCurrent = currentProgress.current;
            currentProgress.current = progress.current;
            currentProgress.total = progress.total;
            currentProgress.completed = progress.current >= progress.total;

            if (domCache['rewards-progress']) {
                domCache['rewards-progress'].textContent =
                    '进度: ' + progress.current + '/' + progress.total + (currentProgress.completed ? ' (已完成)' : '');
            }
            updateProgressBar();
            updateAndSaveState();
            console.log('[RewardsHelper] 进度已更新:', progress.current, '/', progress.total);
        }
    }


    // 保存状态到localStorage
    function saveState() {
        const state = {
            isSearching: isSearching,
            currentProgress: currentProgress,
            usedSearchTerms: [...usedSearchTerms],
            searchStartTime: Date.now(),
            lastActivityTime: Date.now(),
            mainPageSearchTerms: mainPageSearchTerms,
            iframeSearchTerms: iframeSearchTerms
        };
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            console.log('状态已保存到本地存储');
        } catch (e) {
            console.log('保存状态失败:', e.message);
        }
    }

    // 从localStorage加载状态
    function loadState() {
        try {
            const savedState = localStorage.getItem(STORAGE_KEY);
            if (savedState) {
                const state = JSON.parse(savedState);
                const timeSinceLastActivity = Date.now() - (state.lastActivityTime || 0);
                const maxInactiveTime = 5 * 60 * 1000; // 5分钟

                // 如果超过5分钟未活动，清除状态
                if (timeSinceLastActivity > maxInactiveTime) {
                    console.log('状态已过期，清除本地存储');
                    clearState();
                    return null;
                }

                console.log('从本地存储加载状态:', state);
                return state;
            }
        } catch (e) {
            console.log('加载状态失败:', e.message);
        }
        return null;
    }

    // 清除localStorage中的状态
    function clearState() {
        try {
            localStorage.removeItem(STORAGE_KEY);
            console.log('已清除本地存储状态');
        } catch (e) {
            console.log('清除状态失败:', e.message);
        }
    }

    // 创建胶囊风格 UI
    function createUI() {
        const theme = getTheme();
        const CSS = '.brb-panel{transition:opacity .25s,transform .3s cubic-bezier(.4,0,.2,1);position:relative}.brb-panel.collapsed{opacity:0;transform:scale(.85) translateY(8px);pointer-events:none}.brb-toggle{cursor:pointer;user-select:none;display:flex;align-items:center;gap:7px;background:linear-gradient(135deg,'+theme.accent+',#005a9e);color:#fff;padding:8px 14px;border-radius:99px;font-size:12px;font-weight:600;box-shadow:0 2px 12px rgba(0,120,212,.35);transition:transform .2s,box-shadow .2s;border:none}.brb-toggle:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,120,212,.5)}.brb-dot{width:8px;height:8px;border-radius:50%;background:#aaa;transition:background .3s,box-shadow .3s;flex-shrink:0}.capsule-text{font-weight:600;font-size:12px;white-space:nowrap}.capsule-score{font-size:11px;opacity:.9}.expand-arrow{font-size:9px;opacity:.7;transition:transform .3s}.collapsed .expand-arrow{transform:rotate(-90deg)}.brb-hdr{background:linear-gradient(135deg,'+theme.accent+',#005a9e);color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-radius:12px 12px 0 0}.brb-hdr-title{font-weight:600;font-size:13px}.brb-btn{padding:6px 10px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;transition:background .15s}.brb-prog{padding:10px 14px 0}.brb-prog-row{display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:600;color:'+theme.text+';margin-bottom:6px}.brb-prog-track{width:100%;height:5px;border-radius:99px;background:'+theme.inputBorder+';overflow:hidden}.brb-prog-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,'+theme.accent+',#00bcf2);transition:width .4s ease}.brb-status{margin-top:8px;padding:6px 10px;border-radius:8px;background:'+theme.inputBg+';font-size:11px;color:'+theme.text+';display:flex;align-items:center;gap:6px}.brb-dot-sm{width:6px;height:6px;border-radius:50%;background:#aaa;flex-shrink:0}.brb-section{padding:8px 14px;border-top:1px solid '+theme.border+';font-size:11px}.brb-sec-title{font-weight:600;margin-bottom:3px;color:'+theme.textSecondary+';font-size:10px;text-transform:uppercase;letter-spacing:.5px}.brb-terms{padding:6px 14px;background:'+theme.inputBg+';font-size:10px;color:'+theme.text+';word-break:break-all}.brb-actions{padding:8px 14px;display:flex;gap:6px}.brb-start{flex:1;padding:7px 0;border:none;border-radius:8px;cursor:pointer;background:linear-gradient(135deg,'+theme.accent+',#005a9e);color:#fff;font-size:12px;font-weight:600;transition:opacity .15s}.brb-start:hover{opacity:.9}.brb-cfg{padding:7px 10px;border:1px solid '+theme.border+';border-radius:8px;cursor:pointer;background:'+theme.inputBg+';color:'+theme.text+';font-size:12px;transition:background .15s}.brb-cfg:hover{background:'+theme.border+'}.brb-config{padding:0 14px 10px;border-top:1px solid '+theme.border+';max-height:0;overflow:hidden;transition:max-height .3s ease,opacity .2s;opacity:0}.brb-config.open{max-height:300px;opacity:1}.brb-cfg-grid{display:flex;flex-direction:column;gap:6px;margin-top:8px;font-size:11px}.brb-cfg-row{display:flex;align-items:center;justify-content:space-between;color:'+theme.textSecondary+';font-size:10px}.brb-cfg-row label{flex:1}.brb-input{width:56px;padding:3px 5px;border-radius:6px;font-size:11px;text-align:center;border:1px solid '+theme.inputBorder+';background:'+theme.inputBg+';color:'+theme.text+';transition:border-color .2s}.brb-switch{width:30px;height:16px;border-radius:99px;position:relative;cursor:pointer;transition:background .2s;flex-shrink:0;background:'+theme.inputBorder+';border:none}.brb-switch.on{background:'+theme.accent+';border:none}.brb-switch::after{content:\'\';position:absolute;width:12px;height:12px;border-radius:50%;background:#fff;top:2px;left:2px;transition:transform .2s}.brb-switch.on::after{transform:translateX(14px)}.brb-ftr{padding:6px 14px;border-top:1px solid '+theme.border+';display:flex;justify-content:space-between;align-items:center;font-size:10px;color:'+theme.textSecondary+';}';
        if (!document.getElementById('bing-rewards-bot-style')) {
            const style = document.createElement('style');
            style.id = 'bing-rewards-bot-style';
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        const container = document.createElement('div');
        container.id = 'rewards-helper-container';
        container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:10000;';
        const capsule = document.createElement('div');
        capsule.id = 'capsule-btn';
        capsule.className = 'brb-toggle';
        capsule.innerHTML = '<span class="brb-dot" id="status-dot-capsule"></span><span class="capsule-text">Rewards Bot</span><span class="capsule-score" id="capsule-score">0/90</span><span class="expand-arrow">\u25BC</span>';
        capsule.onclick = (e) => {
            if (e.target.closest('.brb-btn') || e.target.closest('.brb-switch') || e.target.closest('.brb-input')) return;
            toggleCollapse();
        };
        container.appendChild(capsule);
        const panel = document.createElement('div');
        panel.id = 'panel-body';
        panel.className = 'brb-panel collapsed';
        panel.style.cssText = 'margin-top:10px;width:300px;background:' + theme.bg + ';color:' + theme.text + ';border:1px solid ' + theme.border + ';border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.2);overflow:hidden;';
        // Header
        const hdr = document.createElement('div');
        hdr.style.cssText = 'background:linear-gradient(135deg,'+theme.accent+',#005a9e);color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-radius:12px 12px 0 0;cursor:move;';
        const hdrL = document.createElement('div'); hdrL.style.cssText='display:flex;align-items:center;gap:8px;';
        const hdrIcon = document.createElement('span'); hdrIcon.textContent='\uD83D\uDD0D'; hdrIcon.style.cssText='font-size:15px;';
        const hdrTitle = document.createElement('div'); hdrTitle.style.cssText='font-weight:600;font-size:13px;'; hdrTitle.textContent='Rewards \u81EA\u52A8\u52A9\u624B';
        hdrL.appendChild(hdrIcon); hdrL.appendChild(hdrTitle);
        const hdrR = document.createElement('button'); hdrR.id='minimize-btn'; hdrR.className='brb-btn';
        hdrR.style.cssText='background:rgba(255,255,255,.2);color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:14px;border:none;';
        hdrR.textContent='\u2212'; hdrR.onclick=toggleCollapse;
        hdr.appendChild(hdrL); hdr.appendChild(hdrR); panel.appendChild(hdr);
        // Progress
        const prog=document.createElement('div'); prog.style.cssText='padding:10px 14px 0;';
        const progRow=document.createElement('div'); progRow.style.cssText='display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:600;color:'+theme.text+';margin-bottom:6px;';
        const progLabel=document.createElement('span'); progLabel.textContent='\u8FDB\u5EA6';
        const progNum=document.createElement('span'); progNum.id='rewards-progress'; progNum.style.cssText='font-size:11px;color:'+theme.accent+';'; progNum.textContent='0/90';
        progRow.appendChild(progLabel); progRow.appendChild(progNum); prog.appendChild(progRow);
        const progTrack=document.createElement('div'); progTrack.style.cssText='width:100%;height:5px;border-radius:99px;background:'+theme.inputBorder+';overflow:hidden;';
        const progFill=document.createElement('div'); progFill.id='rewards-progress-bar'; progFill.style.cssText='width:0%;height:100%;border-radius:99px;background:linear-gradient(90deg,'+theme.accent+',#00bcf2);transition:width .4s ease;';
        progTrack.appendChild(progFill); prog.appendChild(progTrack); panel.appendChild(prog);
        // Status
        const sRow=document.createElement('div'); sRow.style.cssText='margin-top:8px;padding:6px 10px;border-radius:8px;background:'+theme.inputBg+';font-size:11px;color:'+theme.text+';display:flex;align-items:center;gap:6px;';
        const sDot=document.createElement('span'); sDot.style.cssText='width:6px;height:6px;border-radius:50%;background:#aaa;flex-shrink:0;';
        const sText=document.createElement('span'); sText.id='search-status'; sText.style.cssText='flex:1;color:'+theme.text+';'; sText.textContent='\u5C31\u7EEA';
        const sCD=document.createElement('span'); sCD.id='countdown'; sCD.style.cssText='font-size:11px;color:'+theme.accent+';display:none;';
        sRow.appendChild(sDot); sRow.appendChild(sText); sRow.appendChild(sCD); panel.appendChild(sRow);
        // Daily tasks
        const tasksSec=document.createElement('div'); tasksSec.id='daily-tasks-section'; tasksSec.style.cssText='padding:8px 14px;border-top:1px solid '+theme.border+';font-size:11px;';
        const tasksTitle=document.createElement('div'); tasksTitle.id='daily-tasks-summary'; tasksTitle.style.cssText='font-weight:600;margin-bottom:3px;color:'+theme.textSecondary+';font-size:10px;text-transform:uppercase;letter-spacing:.5px;'; tasksTitle.textContent='\u6BCF\u65E5\u4EFB\u52A1';
        const tasksList=document.createElement('div'); tasksList.id='daily-tasks-list'; tasksList.style.cssText='font-size:11px;color:'+theme.text+';padding-left:4px;'; tasksList.textContent='\u52A0\u8F7D\u4E2D...';
        tasksSec.appendChild(tasksTitle); tasksSec.appendChild(tasksList); panel.appendChild(tasksSec);
        // Search terms
        const termsSec=document.createElement('div'); termsSec.id='rewards-search-terms-container'; termsSec.style.cssText='padding:8px 14px;border-top:1px solid '+theme.border+';font-size:10px;color:'+theme.text+';word-break:break-all;background:'+theme.inputBg+';';
        const termsH=document.createElement('div'); termsH.style.cssText='font-weight:600;margin-bottom:4px;font-size:10px;color:'+theme.textSecondary+';text-transform:uppercase;letter-spacing:.5px;'; termsH.textContent='\u641C\u7D22\u8BCD'; termsSec.appendChild(termsH);
        const mtL=document.createElement('div'); mtL.textContent='\u4E3B\u9875: '; mtL.style.cssText='font-weight:600;font-size:10px;';
        const mtEl=document.createElement('div'); mtEl.id='main-search-terms'; mtEl.style.cssText='padding-left:4px;margin-bottom:2px;word-break:break-all;'; termsSec.appendChild(mtL); termsSec.appendChild(mtEl);
        const itL=document.createElement('div'); itL.textContent='\u4FA7\u680F: '; itL.style.cssText='font-weight:600;font-size:10px;margin-top:2px;';
        const itEl=document.createElement('div'); itEl.id='iframe-search-terms'; itEl.style.cssText='padding-left:4px;word-break:break-all;'; termsSec.appendChild(itL); termsSec.appendChild(itEl);
        panel.appendChild(termsSec);
        // Divider
        const div=document.createElement('div'); div.style.cssText='height:1px;background:'+theme.border+';margin:0 14px;'; panel.appendChild(div);
        // Actions
        const btnSec=document.createElement('div'); btnSec.style.cssText='padding:8px 14px;display:flex;gap:6px;';
        const startBtn=document.createElement('button'); startBtn.id='start-search-btn'; startBtn.className='brb-start'; startBtn.textContent='\u25B6 \u5F00\u59CB\u641C\u7D22';
        startBtn.style.cssText='flex:1;padding:7px 0;border:none;border-radius:8px;cursor:pointer;background:linear-gradient(135deg,'+theme.accent+',#005a9e);color:#fff;font-size:12px;font-weight:600;transition:opacity .15s;';
        startBtn.onmouseenter=()=>startBtn.style.opacity='.9'; startBtn.onmouseleave=()=>startBtn.style.opacity='1';
        startBtn.onclick=()=>{ if(!isSearching) startAutomatedSearch(); else stopAutomatedSearch(); };
        const cfgBtn=document.createElement('button'); cfgBtn.className='brb-cfg'; cfgBtn.textContent='\u2699';
        cfgBtn.style.cssText='padding:7px 10px;border:1px solid '+theme.border+';border-radius:8px;cursor:pointer;background:'+theme.inputBg+';color:'+theme.text+';font-size:12px;transition:background .15s;';
        cfgBtn.onmouseenter=()=>cfgBtn.style.background=theme.border; cfgBtn.onmouseleave=()=>cfgBtn.style.background=theme.inputBg;
        cfgBtn.onclick=()=>{ const g=domCache['config-grid']; if(g) g.classList.toggle('open'); };
        btnSec.appendChild(startBtn); btnSec.appendChild(cfgBtn); panel.appendChild(btnSec);
        // Config
        const configSec=document.createElement('div'); configSec.id='rewards-config-section'; configSec.className='brb-config'; configSec.style.cssText='padding:0 14px 10px;border-top:1px solid '+theme.border+';';
        const cfgGrid=document.createElement('div'); cfgGrid.id='config-grid'; cfgGrid.style.cssText='display:flex;flex-direction:column;gap:6px;margin-top:8px;';
        const cfgItems=[{id:'rest-time',label:'\u4F11\u606F\u65F6\u95F4\uFF08\u5206\uFF09',value:config.restTime/60,min:1,max:30},{id:'scroll-time',label:'\u6EDA\u52A8\u65F6\u95F4\uFF08\u79D2\uFF09',value:config.scrollTime,min:1,max:30},{id:'wait-time',label:'\u7B49\u5F85\u65F6\u95F4\uFF08\u79D2\uFF09',value:config.waitTime,min:1,max:30},{id:'max-no-progress',label:'\u5BB9\u9519\u6B21\u6570',value:config.maxNoProgressCount,min:1,max:10}];
        cfgItems.forEach(item=>{ const row=document.createElement('div'); row.style.cssText='display:flex;align-items:center;justify-content:space-between;font-size:10px;color:'+theme.textSecondary+';'; const lbl=document.createElement('label'); lbl.textContent=item.label; const inp=document.createElement('input'); inp.type='number'; inp.id=item.id; inp.value=item.value; inp.min=item.min; inp.max=item.max; inp.className='brb-input'; inp.addEventListener('change',()=>{ const v=parseInt(inp.value)||item.min; if(item.id==='rest-time'){config.restTime=v*60;saveConfig();} else if(item.id==='scroll-time'){config.scrollTime=v;saveConfig();} else if(item.id==='wait-time'){config.waitTime=v;saveConfig();} else if(item.id==='max-no-progress'){config.maxNoProgressCount=v;saveConfig();} updateStatus('\u914D\u7F6E\u5DF2\u66F4\u65B0'); }); row.appendChild(lbl); row.appendChild(inp); cfgGrid.appendChild(row); });
        const swRow=document.createElement('div'); swRow.style.cssText='display:flex;align-items:center;justify-content:space-between;font-size:10px;color:'+theme.textSecondary+';margin-top:4px;';
        const swLbl=document.createElement('label'); swLbl.textContent='\u81EA\u52A8\u70B9\u51FB\u5956\u52B1\u5361\u7247';
        const swEl=document.createElement('div'); swEl.className='brb-switch'+(config.autoClickDailyTasks?' on':'');
        swEl.onclick=()=>{config.autoClickDailyTasks=!config.autoClickDailyTasks;swEl.classList.toggle('on');saveConfig();updateStatus('\u81EA\u52A8\u70B9\u51FB\u5956\u52B1\u5361\u7247: '+ (config.autoClickDailyTasks?'\u5F00\u542F':'\u5173\u95ED'));};
        swRow.appendChild(swLbl); swRow.appendChild(swEl); cfgGrid.appendChild(swRow);
        configSec.appendChild(cfgGrid); panel.appendChild(configSec);
        // Footer
        const ftr=document.createElement('div'); ftr.style.cssText='padding:6px 14px;border-top:1px solid '+theme.border+';display:flex;justify-content:space-between;align-items:center;font-size:10px;color:'+theme.textSecondary+';';
        const ftrL=document.createElement('span'); ftrL.textContent='v1.1.3 \u00B7 SOYS \u00B7 \u6A21\u62DF\u4EBA\u5DE5';
        const ftrR=document.createElement('button'); ftrR.className='brb-btn'; ftrR.style.cssText='background:transparent;border:none;cursor:pointer;color:'+theme.textSecondary+';font-size:14px;padding:2px 4px;border-radius:4px;transition:background .15s;';
        ftrR.textContent='\u2212'; ftrR.onmouseenter=()=>ftrR.style.background=theme.inputBg; ftrR.onmouseleave=()=>ftrR.style.background='transparent'; ftrR.onclick=toggleCollapse;
        ftr.appendChild(ftrL); ftr.appendChild(ftrR); panel.appendChild(ftr);
        container.appendChild(panel); document.body.appendChild(container);
        makeDraggable(container, hdr);
        searchState.isCollapsed=false; applyCollapseState();
    }
    // 让UI窗口可拖动
    function makeDraggable(container, header) {
        let offsetX, offsetY;
        let isDragging = false;

        const onMouseDown = (e) => {
            // 如果点击的是按钮（它们有自己的pointer光标），则不触发拖动
            if (window.getComputedStyle(e.target).cursor === 'pointer') {
                return;
            }

            isDragging = true;

            // switch from bottom/right positioning to top/left for dragging
            if (container.style.bottom || container.style.right) {
                const rect = container.getBoundingClientRect();
                container.style.left = rect.left + 'px';
                container.style.top = rect.top + 'px';
                container.style.right = '';
                container.style.bottom = '';
            }

            offsetX = e.clientX - container.offsetLeft;
            offsetY = e.clientY - container.offsetTop;

            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp, { once: true }); // Use {once: true} for cleanup
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;

            container.style.top = (e.clientY - offsetY) + 'px';
            container.style.left = (e.clientX - offsetX) + 'px';
        };

        const onMouseUp = () => {
            isDragging = false;
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
        };

        header.addEventListener('mousedown', onMouseDown);
    }

    // 更新状态显示
    function updateStatus(message) {
        const statusElement = domCache['search-status'];
        if (statusElement) {
            statusElement.textContent = message;
            // 确保在折叠状态下也显示状态
            if (searchState.isCollapsed) {
                statusElement.style.display = 'block';
            }
        }
        console.log(message);
    }

    // 切换UI折叠状态
    function toggleCollapse() {
        searchState.isCollapsed = !searchState.isCollapsed;
        applyCollapseState();
    }

    // 应用折叠状态
    function applyCollapseState() {
        const panel = domCache['panel-body'];
        const capsule = domCache['capsule-btn'];
        const minimizeBtn = domCache['minimize-btn'];
        const dot = domCache['status-dot-capsule'];
        if (searchState.isCollapsed) {
            if (panel) { panel.classList.add('collapsed'); panel.style.display = 'none'; }
            if (capsule) capsule.style.display = 'flex';
            if (minimizeBtn) minimizeBtn.textContent = '+';
            if (dot) { dot.style.background = '#aaa'; dot.style.boxShadow = 'none'; }
        } else {
            if (panel) { panel.classList.remove('collapsed'); panel.style.display = 'block'; }
            if (capsule) capsule.style.display = 'none';
            if (minimizeBtn) minimizeBtn.textContent = '\u2212';
            if (dot) { dot.style.background = '#00c853'; dot.style.boxShadow = '0 0 6px rgba(0,200,83,.6)'; }
        }
    }

    // 更新进度条
    function updateProgressBar() {
        const bar = document.getElementById('rewards-progress-bar');
        if (bar && currentProgress.total > 0) {
            const pct = Math.min(100, (currentProgress.current / currentProgress.total) * 100);
            bar.style.width = pct + '%';
            if (currentProgress.completed) {
                bar.style.background = 'linear-gradient(90deg, #4CAF50, #8BC34A)';
            }
        }
    }

    // 更新倒计时显示
    function updateCountdown(seconds, action) {
        const countdownElement = domCache['countdown'];
        if (countdownElement) {
            if (seconds > 0) {
                let actionText = '';
                switch (action) {
                    case 'scrolling': actionText = '滚动中'; break;
                    case 'waiting': actionText = '等待中'; break;
                    case 'resting': actionText = '休息中'; break;
                    case 'checking': actionText = '检查中'; break;
                    default: actionText = '倒计时';
                }
                countdownElement.textContent = `${actionText}: ${seconds}秒`;
                countdownElement.style.display = 'block';
            } else {
                countdownElement.style.display = 'none';
            }
        }
    }

    // 更新每日点击任务 UI
    function updateDailyTasksUI(tasks) {
        const tasksList = domCache['daily-tasks-list'];
        if (!tasksList) return;

        const summaryElem = domCache['daily-tasks-summary'];

        while (tasksList.firstChild) tasksList.removeChild(tasksList.firstChild);

        // 生成 summary 图标
        let summaryIcons = '';
        if (!tasks || tasks.length === 0) {
            summaryIcons = '✅✅✅';
        } else {
            summaryIcons = tasks
                .map(t => (t.status === '已完成' ? '✅' : t.status === '未完成' ? '❌' : '❔'))
                .join('');
        }

        if (summaryElem) {
            summaryElem.textContent = `每日任务：${summaryIcons}`;
        }

        // 详细列表
        if (!tasks || tasks.length === 0) {
            const doneElem = document.createElement('div');
            doneElem.textContent = '每日任务已全部完成';
            doneElem.style.color = '#4CAF50';
            tasksList.appendChild(doneElem);
            return;
        }

        tasks.forEach(task => {
            const taskElem = document.createElement('div');
            taskElem.textContent = `${task.name}: ${task.status}`;
            taskElem.style.color = task.status === '未完成' ? '#d83b01' : '#4CAF50';
            tasksList.appendChild(taskElem);
        });
    }

    // 点击打开侧边栏（支持多种选择器）
    function openRewardsSidebar() {
        const selectors = [
            '.points-container',
            '.pointsContainer',
            '[class*="points"]',
            '[data-testid="rewards-points"]',
            'a[href*="/rewards"]',
            '.ms-rewards-link',
            '[aria-label*="积分"]',
            '[aria-label*="Rewards"]'
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                el.click();
                console.log('[RewardsHelper] 已点击积分按钮 (selector: ' + selector + ')');
                return true;
            }
        }

        const allLinks = document.querySelectorAll('a[href*="rewards"], a[href*="Reward"]');
        allLinks.forEach(link => {
            if (!link.href.includes('account') && !link.href.includes('profile')) {
                link.click();
                console.log('[RewardsHelper] 兜底点击了 rewards 链接');
                return true;
            }
        });

        console.log('[RewardsHelper] 未找到积分按钮，尝试其他方式');
        return false;
    }

    // 从iframe中获取数据（兼容跨域情况）
    function getDataFromIframe() {
        const iframe = document.querySelector('iframe');
        if (!iframe) {
            console.log('[RewardsHelper] 未找到iframe');
            return false;
        }

        let iframeDoc;
        try {
            iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            console.log('[RewardsHelper] 成功访问iframe文档 (同源)');
        } catch (e) {
            console.log('[RewardsHelper] iframe 跨域访问被阻止: ' + e.message);
            console.log('[RewardsHelper] iframe src: ' + (iframe.src || 'unknown'));
            if (interceptedRewardsData.progress) {
                console.log('[RewardsHelper] 使用拦截的API数据更新进度');
                updateProgressFromData(interceptedRewardsData.progress);
            }
            if (interceptedRewardsData.dailyTasks.length > 0) {
                console.log('[RewardsHelper] 使用拦截的API数据更新每日任务');
                updateDailyTasksUI(interceptedRewardsData.dailyTasks);
            }
            return true;
        }

        try {

            // 解析每日点击任务（支持新旧两种卡片格式）
            (() => {
                const tasks = [];
                let containerFound = false;

                // --- 方法1: 旧格式容器 (.flyout_control_threeOffers) ---
                const oldContainer = iframeDoc.querySelector('#bingRewards .flyout_control_threeOffers');
                if (oldContainer) {
                    containerFound = true;
                    const offerDivs = oldContainer.querySelectorAll('div[aria-label*="Offer"]');
                    console.log('[RewardsHelper] [旧格式] 每日任务容器中找到 offer 元素:', offerDivs.length);
                    offerDivs.forEach((div, idx) => {
                        if (tasks.length >= 3) return;
                        const ariaLabel = div.getAttribute('aria-label') || '';
                        let status = '未知';
                        const lower = ariaLabel.toLowerCase();
                        if (lower.includes('offer not completed')) status = '未完成';
                        else if (lower.includes('offer is completed') || lower.includes('offer completed')) status = '已完成';
                        const name = ariaLabel.split(' - ')[0] || `任务${idx + 1}`;
                        tasks.push({ name, status });
                    });
                }

                // --- 方法2: 新格式容器 (.promo_card) ---
                // 搜索所有 promo_card，过滤掉推广链接卡片（如"将推荐转化为奖励"）
                const allPromoCards = iframeDoc.querySelectorAll('.promo_cont .promo_card, .promo_cont a.block .promo_card, .fp_row.promo_card');
                const filteredCards = Array.from(allPromoCards).filter(card => {
                    const title = card.querySelector('.promo-title');
                    if (!title) return false;
                    const titleText = title.textContent.trim().toLowerCase();
                    // 排除推广邀请卡片
                    const excludePatterns = ['推荐', 'refer', '邀请', 'share', 'earn 7500'];
                    return !excludePatterns.some(p => titleText.includes(p));
                });
                console.log('[RewardsHelper] [新格式] 找到 promo_card 数量:', filteredCards.length, '(排除推广后)');

                filteredCards.forEach((card, idx) => {
                    if (tasks.length >= 5) return; // 最多5个任务
                    const titleEl = card.querySelector('.promo-title, p[class*="promo-title"]');
                    const titleText = titleEl ? titleEl.textContent.trim() : `任务${idx + 1}`;

                    // 判断是否已完成
                    let status = '未完成';
                    // 方式A: .complete class 在标题或卡片上
                    if (card.classList.contains('complete') ||
                        (titleEl && titleEl.classList.contains('complete')) ||
                        card.querySelector('.complete')) {
                        status = '已完成';
                    }

                    // 尝试提取积分值
                    const pointMatch = titleText.match(/\+(\d+)/);
                    const points = pointMatch ? parseInt(pointMatch[1]) : 0;

                    tasks.push({ name: titleText, status, points });
                });

                // --- 兜底: 如果两种格式都没找到，视为全部完成 ---
                if (!containerFound && filteredCards.length === 0) {
                    console.log('[RewardsHelper] 未找到任何任务容器，视为全部完成');
                }

                console.log('[RewardsHelper] 解析的每日任务:', tasks);
                updateDailyTasksUI(tasks);
                dailyTasksData = tasks;

                // 自动点击未完成的奖励卡片
                if (config.autoClickDailyTasks) {
                    let clickedCount = 0;

                    // 先尝试旧格式
                    if (oldContainer) {
                        const uncompleted = oldContainer.querySelectorAll('div[aria-label*="Offer not Completed"]');
                        uncompleted.forEach((offerDiv) => {
                            const link = offerDiv.querySelector('a[href]');
                            if (link) {
                                console.log('[RewardsHelper] 点击旧格式未完成任务:', offerDiv.getAttribute('aria-label'));
                                link.click();
                                clickedCount++;
                            }
                        });
                    }

                    // 再尝试新格式
                    filteredCards.forEach((card) => {
                        const titleEl = card.querySelector('.promo-title, p[class*="promo-title"]');
                        if (!titleEl) return;
                        const task = tasks.find(t => t.name === titleEl.textContent.trim());
                        if (task && task.status === '已完成') return;
                        const link = card.closest('.promo_cont')?.querySelector('a[href][target="_blank"]');
                        if (link) {
                            console.log('[RewardsHelper] 点击新格式卡片:', titleEl.textContent.trim());
                            link.click();
                            clickedCount++;
                        }
                    });

                    if (clickedCount > 0) {
                        console.log('[RewardsHelper] 本次共点击了', clickedCount, '个奖励卡片');
                    }
                }
            })();

            // 获取进度 - 优先检查实际进度，再检查完成提示
            // 1. 首先尝试获取正常进度显示
            let progressFound = false;
            const progressElement = iframeDoc.querySelector('.daily_search_row span:last-child');
            if (progressElement) {
                const progress = progressElement.textContent;
                domCache['rewards-progress'].textContent = '进度: ' + progress;
                updateProgressBar();
                console.log('搜索进度: ' + progress);

                // 解析进度数字
                const match = progress.match(/(\d+)\/(\d+)/);
                if (match) {
                    const current = parseInt(match[1]);
                    currentProgress.total = parseInt(match[2]);

                    // 检查进度是否增加
                    if (currentProgress.current > 0 && current <= currentProgress.current && isSearching) {
                        console.log(`进度未增加: ${current} <= ${currentProgress.current}，已连续 ${currentProgress.noProgressCount + 1} 次未增加`);
                        currentProgress.noProgressCount++;

                        // 只有当连续多次未增加进度时才休息
                        if (currentProgress.noProgressCount >= config.maxNoProgressCount) {
                            searchState.needRest = true;
                            console.log(`达到最大容错次数 ${config.maxNoProgressCount}，需要休息`);
                        }
                    } else if (current > currentProgress.current) {
                        // 进度增加，重置计数器
                        console.log(`进度增加: ${current} > ${currentProgress.current}，重置未增加计数`);
                        currentProgress.noProgressCount = 0;
                    }

                    currentProgress.current = current;

                    // 检查是否完成
                    if (current >= currentProgress.total) {
                        currentProgress.completed = true;
                        console.log(`进度数字表明任务已完成: ${current}/${currentProgress.total}`);
                    }

                    // 保存状态
                    updateAndSaveState();
                    progressFound = true;

                    // 不再提前返回，继续往下获取搜索词
                }
            } else {
                console.log('未找到进度元素，检查完成提示');
            }

            // 2. 只有在没有找到进度元素时，才检查完成提示和假提示
            if (!progressFound) {
            // 直接获取body文本内容，避免遍历所有元素
            const allEarnedText = iframeDoc.body ? iframeDoc.body.textContent : '';
            console.log('body文本内容:', allEarnedText.substring(0, 200));
            
            // 检查中文假提示
            if (allEarnedText.includes('你已获得') && allEarnedText.includes('积分') && allEarnedText.includes('每天继续搜索')) {
                console.log(`检测到中文假提示`);
                
                const currentMatch = allEarnedText.match(/你已获得\s*(\d+)\s*积分/);
                const totalMatch = allEarnedText.match(/每天继续搜索并获得最多\s*(\d+)\s*奖励积分/);
                
                if (currentMatch && totalMatch) {
                    const currentPoints = parseInt(currentMatch[1]);
                    const totalPoints = parseInt(totalMatch[1]);
                    
                    console.log(`从中文假提示中提取: 当前${currentPoints}分，总共${totalPoints}分`);
                    
                    currentProgress.current = currentPoints;
                    currentProgress.total = totalPoints;
                    currentProgress.completed = false;
                    
                    domCache['rewards-progress'].textContent = `进度: ${currentPoints}/${totalPoints} (从提示获取)`;
                    updateProgressBar();
                    console.log(`从中文假提示更新进度: ${currentPoints}/${totalPoints}`);
                    
                    updateAndSaveState();
                    return true;
                }
            }
            
            // 检查英文假提示
            if (allEarnedText.includes('You earned') && allEarnedText.includes('points') && allEarnedText.includes('Keep searching')) {
                console.log(`检测到英文假提示`);
                
                // 修复正则表达式，处理可能的变体
                const currentMatch = allEarnedText.match(/You earned\s*(\d+)\s*points?(?:\s+already)?/i);
                const totalMatch = allEarnedText.match(/(?:earn\s+up\s+to|get\s+up\s+to)\s*(\d+)\s*(?:Rewards\s+)?points?/i);
                
                console.log('当前积分匹配:', currentMatch);
                console.log('总积分匹配:', totalMatch);
                
                if (currentMatch && totalMatch) {
                    const currentPoints = parseInt(currentMatch[1]);
                    const totalPoints = parseInt(totalMatch[1]);
                    
                    console.log(`从英文假提示中提取: 当前${currentPoints}分，总共${totalPoints}分`);
                    
                    currentProgress.current = currentPoints;
                    currentProgress.total = totalPoints;
                    currentProgress.completed = false;
                    
                    domCache['rewards-progress'].textContent = `进度: ${currentPoints}/${totalPoints} (从提示获取)`;
                    updateProgressBar();
                    console.log(`从英文假提示更新进度: ${currentPoints}/${totalPoints}`);
                    
                    updateAndSaveState();
                    return true;
                } else {
                    console.log('英文假提示正则匹配失败');
                }
            }
            
            // 检查中文真正完成提示
            if (allEarnedText.includes('你已获得') && allEarnedText.includes('积分') && !allEarnedText.includes('每天继续搜索')) {
                console.log(`找到中文完成文本`);
                const match = allEarnedText.match(/你已获得\s*(\d+)\s*积分/);
                if (match) {
                    const totalPoints = parseInt(match[1]);
                    currentProgress.current = totalPoints;
                    currentProgress.total = totalPoints;
                    currentProgress.completed = true;

                    domCache['rewards-progress'].textContent = `进度: ${totalPoints}/${totalPoints} (已完成)`;
                    updateProgressBar();
                    console.log(`搜索任务已完成! 总积分: ${totalPoints}`);
                    
                    clearState();
                    return true;
                }
            }
            
            // 检查英文真正完成提示
            if (allEarnedText.includes('You earned') && allEarnedText.includes('points already') && !allEarnedText.includes('Keep searching')) {
                console.log(`找到英文完成文本`);
                const match = allEarnedText.match(/You earned\s*(\d+)\s*points already/i);
                if (match) {
                    const totalPoints = parseInt(match[1]);
                    currentProgress.current = totalPoints;
                    currentProgress.total = totalPoints;
                    currentProgress.completed = true;

                    domCache['rewards-progress'].textContent = `进度: ${totalPoints}/${totalPoints} (已完成)`;
                    updateProgressBar();
                    console.log(`搜索任务已完成! 总积分: ${totalPoints}`);
                    
                    clearState();
                    return true;
                }
            }
            } // end if (!progressFound)

            // 获取iframe中的搜索词
            let iframeTermsFound = false;

            // method 1: from window.flyoutViewModel variable in iframe
            try {
                const iframeWin = iframe.contentWindow;
                if (iframeWin && iframeWin.flyoutViewModel) {
                    const vm = iframeWin.flyoutViewModel;
                    // try both paths: flyoutResult.suggestedSearches and suggestedSearches
                    const ss = (vm.flyoutResult && vm.flyoutResult.suggestedSearches) || vm.suggestedSearches;
                    if (ss && ss.suggestedItems) {
                        const terms = ss.suggestedItems.map(item => item.query).filter(q => q);
                        if (terms.length > 0) {
                            iframeSearchTerms = [...terms];
                            iframeTermsFound = true;
                            console.log('从flyoutViewModel变量找到iframe搜索词: ' + terms.length + '个');
                        }
                    }
                }
            } catch (e2) {
                console.log('从flyoutViewModel变量获取失败:', e2.message);
            }

            // method 2: parse flyoutViewModel JSON from script tags in iframe
            if (!iframeTermsFound) {
                try {
                    const scripts = iframeDoc.querySelectorAll('script');
                    for (const script of scripts) {
                        const text = script.textContent || '';
                        const idx = text.indexOf('window.flyoutViewModel');
                        if (idx === -1) continue;
                        // find the opening brace
                        const braceStart = text.indexOf('{', idx);
                        if (braceStart === -1) continue;
                        // count braces to find the matching closing brace
                        let depth = 0;
                        let braceEnd = -1;
                        for (let k = braceStart; k < text.length; k++) {
                            if (text[k] === '{') depth++;
                            else if (text[k] === '}') { depth--; if (depth === 0) { braceEnd = k; break; } }
                        }
                        if (braceEnd === -1) continue;
                        try {
                            const viewModel = JSON.parse(text.substring(braceStart, braceEnd + 1));
                            const ss = (viewModel.flyoutResult && viewModel.flyoutResult.suggestedSearches) || viewModel.suggestedSearches;
                            if (ss && ss.suggestedItems) {
                                const terms = ss.suggestedItems
                                    .map(item => item.query).filter(q => q);
                                if (terms.length > 0) {
                                    iframeSearchTerms = [...terms];
                                    iframeTermsFound = true;
                                    console.log('从script标签解析找到iframe搜索词: ' + terms.length + '个');
                                }
                            }
                        } catch (parseErr) {
                            console.log('JSON解析失败:', parseErr.message);
                        }
                        break;
                    }
                } catch (e3) {
                    console.log('从script标签解析搜索词失败:', e3.message);
                }
            }

            // method 3: fallback to old DOM selector
            if (!iframeTermsFound) {
                const searchTermsContainer = iframeDoc.querySelector('.ss_items_wrapper');
                if (searchTermsContainer) {
                    const terms = [];
                    const spans = searchTermsContainer.querySelectorAll('span');
                    spans.forEach(span => {
                        terms.push(span.textContent);
                    });
                    if (terms.length > 0) {
                        iframeSearchTerms = [...terms];
                        iframeTermsFound = true;
                        console.log('从DOM找到iframe搜索词: ' + terms.length + '个');
                    }
                }
            }

            // update sidebar terms UI
            if (iframeTermsFound) {
                const termsContainer = domCache['iframe-search-terms'];
                if (termsContainer) {
                    while (termsContainer.firstChild) termsContainer.removeChild(termsContainer.firstChild);
                    iframeSearchTerms.forEach(term => {
                        const termElem = document.createElement('div');
                        termElem.textContent = term;
                        termsContainer.appendChild(termElem);
                    });
                }
            } else {
                console.log('所有方法均未找到iframe搜索词');
            }

            return true;
        } catch (e) {
            console.log('读取iframe内容出错: ' + e.message);
            return false;
        }
    }

    // 从主文档中获取搜索词
    function getSearchTermsFromMainDoc() {
        const terms = [];
        const currentQ = new URLSearchParams(window.location.search).get('q') || '';

        // method 1: new format - "深入了解" section with b_vList b_divsec
        document.querySelectorAll('.b_vList.b_divsec a[href*="/search?q="]').forEach(a => {
            const text = a.textContent.trim();
            if (text.length > 2 && text.length < 60 && text !== currentQ) {
                terms.push(text);
            }
        });

        // method 2: rslist links
        if (terms.length === 0) {
            document.querySelectorAll('.rslist a[href*="/search?q="]').forEach(a => {
                const text = a.textContent.trim();
                if (text.length > 2 && text.length < 60 && text !== currentQ) {
                    terms.push(text);
                }
            });
        }

        // method 3: old format - richrsrailsugwrapper
        if (terms.length === 0) {
            const suggestionsContainer = document.querySelector('.richrsrailsugwrapper');
            if (suggestionsContainer) {
                suggestionsContainer.querySelectorAll('.richrsrailsuggestion_text').forEach(el => {
                    terms.push(el.textContent.trim());
                });
            }
        }

        if (terms.length > 0) {
            // deduplicate
            mainPageSearchTerms = [...new Set(terms)];

            const termsContainer = domCache['main-search-terms'];
            if (termsContainer) {
                termsContainer.textContent = '';
                mainPageSearchTerms.forEach(term => {
                    const termElem = document.createElement('div');
                    termElem.textContent = term;
                    termsContainer.appendChild(termElem);
                });
            }
            console.log('找到主页面搜索词: ' + mainPageSearchTerms.length + '个');
            return true;
        } else {
            console.log('未找到主页面搜索词');
            return false;
        }
    }

    // 如果没有任何搜索词，使用保底搜索词
    function ensureFallbackSearchTerms() {
        if (mainPageSearchTerms.length === 0 && iframeSearchTerms.length === 0) {
            mainPageSearchTerms = [...fallbackSearchTerms];

            // 更新 UI
            const termsContainer = domCache['main-search-terms'];
            if (termsContainer) {
                termsContainer.textContent = '';
                mainPageSearchTerms.forEach(term => {
                    const termElem = document.createElement('div');
                    termElem.textContent = term;
                    termsContainer.appendChild(termElem);
                });
            }

            console.log('[RewardsHelper] 使用保底搜索词:', fallbackSearchTerms);
            updateStatus('使用保底搜索词启动');
            return true;
        }
        return false;
    }

    // 获取Rewards数据（带重试机制）
    function getRewardsData(callback, retryCount = 0, maxRetries = 3) {
        updateStatus('正在获取奖励数据...');
        
        if (openRewardsSidebar()) {
            // 使用轮询检查iframe是否加载完成
            let attempts = 0;
            const maxAttempts = 20; // 最多尝试20次，每次500ms，总共10秒
            
            const checkIframeReady = () => {
                attempts++;
                
                try {
                    const iframe = document.querySelector('iframe');
                    if (!iframe) {
                        if (attempts < maxAttempts) {
                            setTimeout(checkIframeReady, 500);
                            return;
                        } else {
                            throw new Error('未找到iframe');
                        }
                    }
                    
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    if (!iframeDoc || iframeDoc.readyState !== 'complete') {
                        if (attempts < maxAttempts) {
                            setTimeout(checkIframeReady, 500);
                            return;
                        } else {
                            throw new Error('iframe未完全加载');
                        }
                    }
                    
                    // iframe已经就绪，获取数据
                    const iframeLoaded = getDataFromIframe();
                    const mainTermsLoaded = getSearchTermsFromMainDoc();

                    // 检查是否从拦截的API数据中获得了进度
                    const hasInterceptedData = interceptedRewardsData.progress !== null;
                    if (hasInterceptedData) {
                        console.log('[RewardsHelper] 从网络拦截获取到进度数据');
                    }

                    if (!iframeLoaded && !mainTermsLoaded && !hasInterceptedData) {
                        throw new Error('获取数据失败');
                    }

                    updateStatus('数据获取成功' + (hasInterceptedData ? ' (API拦截)' : ''));
                    updateAndSaveState(); // 保存状态
                    
                    if (currentProgress.completed) {
                        updateStatus('搜索任务已完成！');
                        if (isSearching) {
                            showCompletionNotification();
                            stopAutomatedSearch();
                        }
                    }

                    // 如果检测到需要休息，并且正在搜索
                    if (searchState.needRest && isSearching) {
                        startResting();
                    } else if (callback) {
                        callback();
                    }
                    
                } catch (error) {
                    console.log(`数据获取尝试 ${attempts} 失败:`, error.message);
                    
                    if (attempts >= maxAttempts) {
                        // 达到最大尝试次数，考虑重试
                        if (retryCount < maxRetries) {
                            console.log(`第 ${retryCount + 1} 次重试获取数据...`);
                            updateStatus(`获取数据失败，正在重试 (${retryCount + 1}/${maxRetries})...`);
                            setTimeout(() => {
                                getRewardsData(callback, retryCount + 1, maxRetries);
                            }, 2000);
                        } else {
                            updateStatus('获取数据失败，请手动重试');
                            if (callback) callback();
                        }
                    } else {
                        setTimeout(checkIframeReady, 500);
                    }
                }
            };
            
            // 开始检查iframe状态
            setTimeout(checkIframeReady, 500);
            
        } else {
            if (retryCount < maxRetries) {
                console.log(`未找到积分按钮，重试中... (${retryCount + 1}/${maxRetries})`);
                updateStatus(`未找到积分按钮，正在重试 (${retryCount + 1}/${maxRetries})...`);
                setTimeout(() => {
                    getRewardsData(callback, retryCount + 1, maxRetries);
                }, 2000);
            } else {
                updateStatus('未找到积分按钮，请确保已登录');
                if (callback) callback();
            }
        }
    }

    // 开始休息
    function startResting() {
        searchState.needRest = false;
        // 重置未增加计数
        currentProgress.noProgressCount = 0;
        updateStatus(`连续 ${config.maxNoProgressCount} 次搜索无进度，休息 ${config.restTime / 60} 分钟后继续`);
        startCountdown(config.restTime, 'resting', () => {
            updateStatus('休息结束，继续搜索');
            setTimeout(performNextSearch, 1000);
        });
    }

    // generate random suffix to make search terms unique
    function generateRandomSuffix() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const len = Math.floor(Math.random() * 3) + 2; // 2-4 chars
        let suffix = '';
        for (let i = 0; i < len; i++) {
            suffix += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return suffix;
    }

    // check if current terms are from fallback list
    function isFallbackMode() {
        return mainPageSearchTerms.length > 0 &&
            mainPageSearchTerms.every(t => fallbackSearchTerms.includes(t)) &&
            iframeSearchTerms.length === 0;
    }

    // 获取搜索词（优先主页面，其次iframe）
    function getSearchTerm() {
        // 创建可用搜索词数组（排除已使用的搜索词）
        let availableMainTerms = mainPageSearchTerms.filter(term => !usedSearchTerms.has(term));
        let availableIframeTerms = iframeSearchTerms.filter(term => !usedSearchTerms.has(term));

        // 如果所有搜索词都已使用过，重置已使用列表
        if (availableMainTerms.length === 0 && availableIframeTerms.length === 0 &&
            (mainPageSearchTerms.length > 0 || iframeSearchTerms.length > 0)) {
            console.log('所有搜索词已用完，重置已使用列表');
            usedSearchTerms.clear();
            availableMainTerms = [...mainPageSearchTerms];
            availableIframeTerms = [...iframeSearchTerms];
        }

        // 优先使用主页面搜索词
        if (availableMainTerms.length > 0) {
            const randomIndex = Math.floor(Math.random() * availableMainTerms.length);
            const baseTerm = availableMainTerms[randomIndex];
            // add random suffix in fallback mode to avoid duplicate searches
            const term = isFallbackMode() ? `${baseTerm} ${generateRandomSuffix()}` : baseTerm;
            // 添加到已使用列表
            usedSearchTerms.add(baseTerm);
            console.log(`选择搜索词: ${term} (主页面，还有 ${availableMainTerms.length - 1} 个未使用)`);
            return {
                term: term,
                source: isFallbackMode() ? '保底' : '主页面'
            };
        }
        // 如果主页面没有搜索词，使用iframe搜索词
        else if (availableIframeTerms.length > 0) {
            const randomIndex = Math.floor(Math.random() * availableIframeTerms.length);
            const term = availableIframeTerms[randomIndex];
            // 添加到已使用列表
            usedSearchTerms.add(term);
            console.log(`选择搜索词: ${term} (iframe，还有 ${availableIframeTerms.length - 1} 个未使用)`);
            return {
                term: term,
                source: 'iframe'
            };
        }

        // 如果都没有搜索词，返回null
        return null;
    }

    // 执行搜索
    function performSearch(term) {
        if (!term) return false;

        const searchBox = document.querySelector('#sb_form_q');
        if (searchBox) {
            searchBox.value = term;

            const searchForm = document.querySelector('#sb_form');
            if (searchForm) {
                searchForm.submit();
                return true;
            }
        }
        return false;
    }

    // 模拟滚动
    function simulateScrolling(callback) {
        updateStatus('正在滚动页面...');
        searchState.currentAction = 'scrolling';

        // 开始倒计时
        startCountdown(config.scrollTime, 'scrolling', callback);

        // 模拟随机滚动
        scrollIntervalId = setInterval(() => {
            // 随机滚动距离
            const scrollAmount = Math.floor(Math.random() * 300) + 100;
            const scrollDirection = Math.random() > 0.3 ? 1 : -1; // 70%向下，30%向上

            window.scrollBy(0, scrollAmount * scrollDirection);

            // 如果当前动作不是滚动，停止滚动
            if (searchState.currentAction !== 'scrolling') {
                clearInterval(scrollIntervalId);
                scrollIntervalId = null;
            }
        }, 1000);

        // 滚动结束后停止滚动
        setTimeout(() => {
            if (scrollIntervalId) {
                clearInterval(scrollIntervalId);
                scrollIntervalId = null;
            }
        }, config.scrollTime * 1000);
    }

    // 检查进度
    function checkProgress(callback) {
        updateStatus('正在检查搜索进度...');
        searchState.currentAction = 'checking';

        if (openRewardsSidebar()) {
            setTimeout(() => {
                getDataFromIframe();

                if (currentProgress.completed) {
                    showCompletionNotification();
                    updateStatus('搜索任务已完成！');
                    stopAutomatedSearch();
                    return;
                }

                if (searchState.needRest) {
                    startResting();
                } else if (callback) {
                    callback();
                }
            }, 1500);
        } else {
            updateStatus('无法打开侧边栏检查进度');
            if (callback) callback();
        }
    }

    // 等待下一次搜索（使用 searchInterval 随机化间隔）
    function waitForNextSearch() {
        updateStatus('等待下一次搜索...');
        const minSec = config.searchInterval[0];
        const maxSec = config.searchInterval[1];
        const waitSec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
        startCountdown(waitSec, 'waiting', performNextSearch);
    }

    // 执行下一次搜索
    function performNextSearch() {
        // 如果不在搜索状态，停止
        if (!isSearching) return;

        // 计算还需要搜索的次数
        const remainingSearches = currentProgress.total - currentProgress.current;
        if (remainingSearches <= 0 || currentProgress.completed) {
            showCompletionNotification();
            updateStatus('搜索任务已完成！');
            stopAutomatedSearch();
            return;
        }

        // 先更新搜索词列表，然后再获取搜索词
        updateStatus('获取最新搜索词...');
        getSearchTermsFromMainDoc();

        // 获取搜索词
        const searchTermObj = getSearchTerm();

        if (!searchTermObj) {
            updateStatus('没有可用的搜索词，获取数据...');
            getRewardsData(() => {
                // 如果仍然没有搜索词，尝试使用保底搜索词
                ensureFallbackSearchTerms();

                // 重新检查是否有搜索词
                const newSearchTermObj = getSearchTerm();
                if (newSearchTermObj) {
                    // 有搜索词，重新执行搜索
                    setTimeout(performNextSearch, 1000);
                } else {
                    updateStatus('无法获取搜索词，停止搜索');
                    stopAutomatedSearch();
                }
            });
            return;
        }

        const { term, source } = searchTermObj;
        updateStatus(`正在搜索: ${term} (${source}搜索词) [剩余:${remainingSearches}]`);

        if (performSearch(term)) {
            // 搜索成功后模拟滚动
            setTimeout(() => {
                simulateScrolling(() => {
                    // 滚动结束后检查进度
                    checkProgress(() => {
                        // 检查进度后等待下一次搜索
                        waitForNextSearch();
                    });
                });
            }, 2000);
        } else {
            updateStatus('搜索失败，请检查网页状态');
            // 3秒后重试
            setTimeout(performNextSearch, 3000);
        }
    }

    // 开始自动搜索
    function startAutomatedSearch() {
        // 首先检查是否有搜索词，如果没有就获取
        if (mainPageSearchTerms.length === 0 && iframeSearchTerms.length === 0) {
            updateStatus('获取搜索词中...');
            getRewardsData(() => {
                if (mainPageSearchTerms.length === 0 && iframeSearchTerms.length === 0) {
                    // 使用保底搜索词
                    ensureFallbackSearchTerms();
                }
                if (mainPageSearchTerms.length === 0 && iframeSearchTerms.length === 0) {
                    alert('没有搜索词，无法开始搜索');
                    return;
                }
                // 有搜索词，开始搜索
                startSearchProcess();
            });
        } else {
            startSearchProcess();
        }
    }

    // 开始搜索流程
    function startSearchProcess() {
        isSearching = true;
        searchState.needRest = false;
        currentProgress.noProgressCount = 0;  // 重置未增加计数
        usedSearchTerms.clear(); // 重置已使用搜索词列表
        domCache['start-search-btn'].textContent = '⏹ 停止搜索';
        domCache['start-search-btn'].style.background = 'linear-gradient(135deg, #d83b01, #a4262c)';
        updateStatus('自动搜索已开始...');

        // 保存状态
        saveState();

        // 计算还需要搜索的次数
        const remainingSearches = currentProgress.total - currentProgress.current;
        if (remainingSearches <= 0 || currentProgress.completed) {
            updateStatus('搜索任务已完成！');
            stopAutomatedSearch();
            return;
        }

        // 开始第一次搜索
        performNextSearch();
    }

    // 恢复状态
    function restoreState() {
        const savedState = loadState();
        if (savedState && savedState.isSearching) {
            // 恢复变量状态
            currentProgress = savedState.currentProgress || currentProgress;
            usedSearchTerms = new Set(savedState.usedSearchTerms || []);
            mainPageSearchTerms = savedState.mainPageSearchTerms || [];
            iframeSearchTerms = savedState.iframeSearchTerms || [];

            // 更新UI显示
            if (currentProgress.current !== undefined && currentProgress.total !== undefined) {
                const progressText = currentProgress.completed ? 
                    `进度: ${currentProgress.current}/${currentProgress.total} (已完成)` :
                    `进度: ${currentProgress.current}/${currentProgress.total}`;
                const progressElement = domCache['rewards-progress'];
                if (progressElement) {
                    progressElement.textContent = progressText;
                }
            }

            updateStatus('检测到之前的搜索任务，正在恢复...');
            
            // 延迟启动自动搜索，给页面时间初始化
            setTimeout(() => {
                if (!currentProgress.completed) {
                    console.log('恢复搜索状态，继续之前的搜索任务');
                    startSearchProcess();
                } else {
                    updateStatus('之前的搜索任务已完成');
                    clearState();
                }
            }, 3000);
            
            return true;
        }
        return false;
    }

    // 在关键操作时保存状态（防抖，避免频繁写入）
    let saveStateTimer = null;
    function updateAndSaveState() {
        if (!isSearching) return;
        if (saveStateTimer) clearTimeout(saveStateTimer);
        saveStateTimer = setTimeout(() => {
            saveState();
            saveStateTimer = null;
        }, 2000);
    }

    // 停止自动搜索
    function stopAutomatedSearch() {
        // 清除倒计时
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        // 清除滚动定时器
        if (scrollIntervalId) {
            clearInterval(scrollIntervalId);
            scrollIntervalId = null;
        }
        // 清除保存状态的防抖计时器
        if (saveStateTimer) {
            clearTimeout(saveStateTimer);
            saveStateTimer = null;
        }

        isSearching = false;
        searchState.currentAction = 'idle';
        searchState.needRest = false;
        currentProgress.noProgressCount = 0;  // 重置未增加计数
        usedSearchTerms.clear(); // 重置已使用搜索词列表
        updateCountdown(0, '');

        // 清除持久化状态
        clearState();

        domCache['start-search-btn'].textContent = '▶ 开始搜索';
        domCache['start-search-btn'].style.background = `linear-gradient(135deg, ${getTheme().accent}, #005a9e)`;
        updateStatus('搜索已停止');
    }

    // 显示完成通知
    function showCompletionNotification() {
        // 创建通知元素
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background-color: #0078d4;
            color: white;
            padding: 20px;
            border-radius: 5px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            z-index: 10001;
            text-align: center;
            font-size: 16px;
        `;
        const notifTitle = document.createElement('div');
        notifTitle.style.cssText = 'font-weight: bold; margin-bottom: 10px; font-size: 18px;';
        notifTitle.textContent = '任务完成！';
        notification.appendChild(notifTitle);

        const notifBody = document.createElement('div');
        notifBody.textContent = `已完成所有 ${currentProgress.total} 次搜索任务`;
        notification.appendChild(notifBody);

        const closeBtn2 = document.createElement('button');
        closeBtn2.id = 'notification-close';
        closeBtn2.textContent = '关闭';
        closeBtn2.style.cssText = 'margin-top: 15px; padding: 5px 15px; background-color: white; color: #0078d4; border: none; border-radius: 3px; cursor: pointer;';
        notification.appendChild(closeBtn2);
        document.body.appendChild(notification);

        // 添加关闭按钮事件
        document.getElementById('notification-close').addEventListener('click', function () {
            notification.remove();
        });

        // 10秒后自动关闭
        setTimeout(() => {
            if (document.body.contains(notification)) {
                notification.remove();
            }
        }, 10000);
    }

    // 开始倒计时
    function startCountdown(seconds, action, callback) {
        // 清除现有倒计时
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }

        searchState.currentAction = action;
        searchState.countdown = seconds;

        updateCountdown(seconds, action);

        countdownTimer = setInterval(() => {
            searchState.countdown--;
            updateCountdown(searchState.countdown, action);

            if (searchState.countdown <= 0) {
                clearInterval(countdownTimer);
                countdownTimer = null;
                if (callback) callback();
            }
        }, 1000);
    }

    // re-apply theme colors to all UI elements
    function applyTheme() {
        const theme = getTheme();
        const capsule = domCache['capsule-btn'];
        const panel = domCache['panel-body'];
        const dot = domCache['status-dot-capsule'];
        if (capsule) {
            capsule.style.background = 'linear-gradient(135deg,' + theme.accent + ',#005a9e)';
            capsule.style.boxShadow = '0 2px 12px rgba(0,120,212,.35)';
        }
        if (panel) {
            panel.style.backgroundColor = theme.bg;
            panel.style.color = theme.text;
            panel.style.borderColor = theme.border;
        }
        if (dot) { dot.style.background = '#aaa'; dot.style.boxShadow = 'none'; }
        const status = domCache['search-status'];
        if (status) { status.style.backgroundColor = theme.inputBg; status.style.color = theme.text; }
        const cfgSec = domCache['rewards-config-section'];
        if (cfgSec) cfgSec.style.borderTopColor = theme.border;
        const termsCont = domCache['rewards-search-terms-container'];
        if (termsCont) termsCont.style.backgroundColor = theme.inputBg;
        const btn = domCache['start-search-btn'];
        if (btn && !isSearching) { btn.style.background = 'linear-gradient(135deg,' + theme.accent + ',#005a9e)'; }
        const container = domCache['rewards-helper-container'];
        if (container) {
            container.querySelectorAll('input[type=number]').forEach(input => {
                input.style.background = theme.inputBg;
                input.style.color = theme.text;
                input.style.borderColor = theme.inputBorder;
            });
        }
    }
    // 在页面加载完成后初始化
    function init() {
        console.log('Microsoft Rewards 助手已加载');
        createUI();
        cacheDomElements();
        applyCollapseState();
        interceptNetworkRequests();

        const observer = new MutationObserver(() => applyTheme());
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-darkmode'] });
        if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

        setTimeout(() => {
            const restored = restoreState();
            if (!restored) {
                setTimeout(() => {
                    getRewardsData();
                }, 1000);
            }
        }, 1000);
    }

    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();
