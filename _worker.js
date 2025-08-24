let mytoken = 'passwd';

export default {
    async fetch(request, env) {
        try {
            mytoken = env.TOKEN || mytoken;

            if (!env.KV) {
                throw new Error('KV 命名空间未绑定');
            }

            const url = new URL(request.url);
            const token = url.pathname === `/${mytoken}` ? mytoken : (url.searchParams.get('token') || "null");

            if (token !== mytoken) {
                return createResponse('token 有误', 403);
            }

            let fileName = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
            fileName = fileName.toLowerCase(); // 将文件名转换为小写

            switch (fileName) {
                case "config":
                case mytoken:
                    // 获取存储的 IP 地址内容，最多 2000 行
                    const ipList = await getIPList(env.KV);
                    return createResponse(configHTML(url.hostname, token, ipList), 200, { 'Content-Type': 'text/html; charset=UTF-8' });
                case "config/update.bat":
                    return createResponse(generateBatScript(url.hostname, token), 200, { "Content-Disposition": 'attachment; filename=update.bat', "Content-Type": "text/plain; charset=utf-8" });
                case "config/update.sh":
                    return createResponse(generateShScript(url.hostname, token), 200, { "Content-Disposition": 'attachment; filename=update.sh', "Content-Type": "text/plain; charset=utf-8" });
                default:
                    return await handleFileOperation(env.KV, fileName, url, token);
            }
        } catch (error) {
            console.error("Error:", error);
            return createResponse(`Error: ${error.message}`, 500);
        }
    }
};

/**
 * 获取最多 2000 行 IP 地址列表
 * @param {Object} KV - KV 命名空间实例
 */
async function getIPList(KV) {
    const value = await KV.get('ip.txt', { cacheTtl: 60 });
    if (!value) {
        return "没有 IP 地址数据";
    }

    // 获取前 2000 行 IP 地址
    const ipList = value.split('\n').slice(0, 2000).join('\n');
    return ipList;
}

/**
 * 处理文件操作
 * @param {Object} KV - KV 命名空间实例
 * @param {String} fileName - 文件名
 * @param {Object} url - URL 实例
 * @param {String} token - 认证 token
 */
async function handleFileOperation(KV, fileName, url, token) {
    const text = url.searchParams.get('text') || null;
    const b64 = url.searchParams.get('b64') || null;

    // 如果没有传递 text 或 b64 参数，尝试从 KV 存储中获取文件内容
    if (!text && !b64) {
        const value = await KV.get(fileName, { cacheTtl: 60 });
        if (value === null) {
            return createResponse('File not found', 404);
        }
        return createResponse(value);
    }

    // 如果传递了 text 或 b64 参数，将内容写入 KV 存储
    let content = text || base64Decode(replaceSpacesWithPlus(b64));
    await KV.put(fileName, content);
    const verifiedContent = await KV.get(fileName, { cacheTtl: 60 });

    if (verifiedContent !== content) {
        throw new Error('Content verification failed after write operation');
    }

    return createResponse(verifiedContent);
}

/**
 * 创建 HTTP 响应
 * @param {String} body - 响应内容
 * @param {Number} status - HTTP 状态码
 * @param {Object} additionalHeaders - 额外的响应头部信息
 */
function createResponse(body, status = 200, additionalHeaders = {}) {
    const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'ETag': Math.random().toString(36).substring(2, 15),
        'Last-Modified': new Date().toUTCString(),
        'cf-cache-status': 'DYNAMIC',
        ...additionalHeaders
    };
    return new Response(body, { status, headers });
}

/**
 * 解码 base64 字符串
 * @param {String} str - base64 字符串
 */
function base64Decode(str) {
    try {
        const bytes = new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
        return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
        throw new Error('Invalid base64 string');
    }
}

/**
 * 将字符串中的空格替换为加号
 * @param {String} str - 输入字符串
 */
function replaceSpacesWithPlus(str) {
    return str.replace(/ /g, '+');
}

/**
 * 生成 Windows bat 脚本
 * @param {String} domain - 域名
 * @param {String} token - 认证 token
 */
function generateBatScript(domain, token) {
    return [
        '@echo off',
        'chcp 65001',
        'setlocal',
        '',
        `set "DOMAIN=${domain}"`,
        `set "TOKEN=${token}"`,
        '',
        'set "FILENAME=%~nx1"',
        '',
        'for /f "delims=" %%i in (\'powershell -command "$content = ((Get-Content -Path \'%cd%/%FILENAME%\' -Encoding UTF8) | Select-Object -First 2000) -join [Environment]::NewLine; [convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($content))"\') do set "BASE64_TEXT=%%i"',
        '',
        'set "URL=https://%DOMAIN%/%FILENAME%?token=%TOKEN%^&b64=%BASE64_TEXT%"',
        '',
        'start %URL%',
        'endlocal',
        '',
        'echo 更新数据完成,倒数5秒后自动关闭窗口...',
        'timeout /t 5 >nul',
        'exit'
    ].join('\r\n');
}

/**
 * 生成 Linux sh 脚本
 * @param {String} domain - 域名
 * @param {String} token - 认证 token
 */
function generateShScript(domain, token) {
    return `#!/bin/bash
export LANG=zh_CN.UTF-8
DOMAIN="${domain}"
TOKEN="${token}"
if [ -n "$1" ]; then 
  FILENAME="$1"
else
  echo "无文件名"
  exit 1
fi
BASE64_TEXT=$(head -n 2000 $FILENAME | base64 -w 0)
curl -k "https://${domain}/${FILENAME}?token=${token}&b64=${BASE64_TEXT}"
echo "更新数据完成"
`;
}

/**
 * 生成 HTML 配置页面
 * @param {String} domain - 域名
 * @param {String} token - 认证 token
 * @param {String} ipList - IP 地址列表
 */
function configHTML(domain, token, ipList) {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CF-Workers-TEXT2KV 配置信息</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 15px; max-width: 800px; margin: 0 auto; }
        h1 { text-align: center; }
        h2 { text-align: left; font-size:1.3rem}
        pre,code { padding: 0px; border-radius: 8px; overflow-x: auto; white-space: nowrap; }
        pre code { background: none; padding: 0; border: none; }
        button { 
        white-space: nowrap;
        cursor: pointer; 
        padding: 10px 10px; 
        margin-top: 0px; 
        border: none; 
        border-radius: 5px; 
    flex-shrink: 0; /* 防止按钮缩小 */
        }
        button:hover { opacity: 0.9; }
        input[type="text"] { 
            padding: 9px 10px;
            border-radius: 5px;
            flex-grow: 1;
            min-width:0;
        }
        .tips {
            color:grey;
            font-size:0.8em;
            border-left: 1px solid #666;
            padding-left: 10px;
        }
        .container { 
        padding: 5px 15px 15px 15px; 
        border-radius: 10px; 
        box-shadow: 0 0 10px rgba(0, 0, 0, 0.1); }
    </style>
</head>
<body>
    <h1>TEXT2KV 配置信息</h1>
    <div class="container">
        <h2>IP 地址列表</h2>
        <pre>${ipList}</pre>  <!-- 渲染 IP 地址列表 -->
    </div>
</body>
</html>
`;
}
