 const express = require('express');
const { createClient } = require('oicq');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// ============================================================
// 全局状态
// ============================================================
let client = null;
let isRunning = false;
let isLoggedIn = false;
let startTime = null;
let botConfig = {
    token: '',
    teamId: '',
    inviteType: 'team',
    allowedGroups: [],
    proxyUrl: 'https://lzrlkghbvyugjoqjuept.supabase.co/functions/v1/proxy'
};
let currentQR = null;

// ============================================================
// 清风邮件引擎
// ============================================================
async function sendInvite(email, token, teamId, inviteType, proxyUrl) {
    const url = inviteType === 'team' 
        ? `/v1/teams/${teamId}/invites` 
        : '/v1/referralInvites';
    const payload = {
        requests: [{
            method: 'POST',
            url: url,
            body: JSON.stringify({ email })
        }]
    };
    try {
        const resp = await fetch(proxyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `PG ${token}`,
                'X-Target-URL': 'https://welovepg.polymail.io/v3/batch'
            },
            body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (resp.ok && data.length > 0 && data[0].code === 200) {
            if (inviteType === 'team' && data[0].body?.id) {
                const inviteId = data[0].body.id;
                await fetch(proxyUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `PG ${token}`,
                        'X-Target-URL': 'https://welovepg.polymail.io/v3/batch'
                    },
                    body: JSON.stringify({
                        requests: [{
                            method: 'DELETE',
                            url: `/v1/teams/${teamId}/invites/${inviteId}`
                        }]
                    })
                });
            }
            return { success: true };
        } else {
            const err = data[0]?.body?.message || data?.message || '未知错误';
            return { success: false, error: err };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ============================================================
// QQ机器人
// ============================================================
function startBot() {
    if (client) return;
    currentQR = null;
    isLoggedIn = false;
    client = createClient();
    client.on('system.login.qrcode', function (event) {
        currentQR = event.image;
        console.log('📱 二维码已生成');
    });
    client.on('system.online', () => {
        isRunning = true;
        isLoggedIn = true;
        startTime = Date.now();
        currentQR = null;
        console.log('✅ 机器人已上线');
    });
    client.on('system.offline', () => {
        isRunning = false;
        isLoggedIn = false;
        console.log('⏹️ 机器人已离线');
    });
    client.on('message.group', (event) => {
        if (botConfig.allowedGroups.length > 0) {
            const groupId = event.group_id.toString();
            if (!botConfig.allowedGroups.includes(groupId)) return;
        }
        const msg = event.raw_message;
        const senderId = event.user_id;
        const senderName = event.sender.nickname || '未知';
        const joinPattern = /(.+?)\s*加入了群聊|(.+?)\s+joined\s+the\s+group/i;
        const match = msg.match(joinPattern);
        if (match) {
            const nickname = match[1] || match[2] || senderName;
            const email = `${senderId}@qq.com`;
            console.log(`🎯 新人入群：${nickname}（${senderId}）→ ${email}`);
            sendInvite(email, botConfig.token, botConfig.teamId, botConfig.inviteType, botConfig.proxyUrl)
                .then(result => {
                    if (result.success) {
                        console.log(`✅ 邀请已发送至 ${email}`);
                        event.reply(`欢迎 ${nickname}，邀请邮件已发往你的 QQ 邮箱。`);
                    } else {
                        console.log(`❌ 发送失败：${result.error}`);
                    }
                });
        }
    });
    client.login();
    console.log('🔄 正在登录 QQ...');
}

function stopBot() {
    if (client) {
        client.logout();
        client = null;
        isRunning = false;
        isLoggedIn = false;
        currentQR = null;
        console.log('⏹️ 机器人已停止');
    }
}

// ============================================================
// HTTP 路由
// ============================================================
app.get('/ping', (req, res) => {
    res.json({
        code: 0,
        msg: 'ok',
        running: isRunning,
        loggedIn: isLoggedIn,
        uptime: startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
        qr: currentQR || null
    });
});

app.post('/login', (req, res) => {
    const { token, teamId, inviteType, proxyUrl } = req.body;
    if (!token || !teamId) {
        return res.status(400).json({ code: 1, msg: '缺少 token 或 teamId' });
    }
    if (isLoggedIn) {
        return res.json({ code: 0, msg: '已登录', loggedIn: true });
    }
    if (!client) {
        botConfig.token = token;
        botConfig.teamId = teamId;
        botConfig.inviteType = inviteType || 'team';
        botConfig.proxyUrl = proxyUrl || 'https://lzrlkghbvyugjoqjuept.supabase.co/functions/v1/proxy';
        startBot();
    }
    res.json({
        code: 0,
        msg: '登录请求已发送',
        qr: currentQR || null
    });
});

app.post('/start', (req, res) => {
    const { allowedGroups } = req.body;
    if (!isLoggedIn) {
        return res.status(400).json({ code: 1, msg: '请先登录 QQ' });
    }
    if (!allowedGroups) {
        return res.status(400).json({ code: 1, msg: '缺少 allowedGroups' });
    }
    botConfig.allowedGroups = allowedGroups.split(',').map(s => s.trim()).filter(Boolean);
    res.json({
        code: 0,
        msg: `监控已启动，群: ${botConfig.allowedGroups.join(', ')}`
    });
});

app.post('/stop', (req, res) => {
    stopBot();
    res.json({ code: 0, msg: '已停止' });
});

// ============================================================
// 启动服务器
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 服务运行在端口 ${PORT}`);
});
