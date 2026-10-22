# 生图广场模板库（服务器托管）

模板库不在前端二进制里，存在服务器的数据目录下。运维增删模板、换预览图都只改文件，**不用重新构建镜像，也不用重启容器**（目录按请求读取）。

## 目录结构

宿主机上的持久卷 `sub2api_sub2api_data` 挂载到容器的 `/app/data`，模板库放在：

```
<data_dir>/imagegen-assets/templates/
├── templates.json          # 模板清单
└── previews/               # 预览图，路径相对 templates.json
    ├── xxx.webp
    └── yyy.jpg
```

容器内的 `data_dir` 默认是 `/app/data`（`config.yaml` 的 `data_dir`，或 `PRICING_DATA_DIR`），所以容器内路径是 `/app/data/imagegen-assets/templates/`。

首次部署时把 `deploy/imagegen-assets/` 整个拷进持久卷：

```bash
# 在宿主机上，容器名 sub2api
docker cp deploy/imagegen-assets/. sub2api:/app/data/imagegen-assets/
```

## 访问地址

后端路由挂在面板 API 组下：

```
GET /api/v1/imagegen-assets/templates/templates.json
GET /api/v1/imagegen-assets/templates/previews/<文件名>
```

前端 `templateCatalog.ts` 通过 `buildApiUrl()` 拼出这个地址，所以改了 `VITE_API_BASE_URL` 也不用动前端。`.json` 返回 `Cache-Control: no-cache`（运营改完立刻生效），图片返回 `public, max-age=3600`。

路由无鉴权，和页面配图（`/api/v1/pages/:slug/images/*`）一致 —— 浏览器 `<img>` 带不了 token。文件按绝对路径解析并确认仍在资源根目录内，目录与穿越路径一律 404。

## templates.json 格式

顶层是对象，`templates` 是数组；写成裸数组也认。

```json
{
  "templates": [
    {
      "id": "poster-01",
      "name": "电影海报",
      "category": "海报广告",
      "tag": "海报",
      "desc": "高对比、居中构图",
      "prompt": "cinematic poster, dramatic lighting, ...",
      "preview": "previews/poster-01.webp",
      "params": {
        "size": "1024x1536",
        "quality": "high",
        "count": 1,
        "format": "png",
        "style": "cinematic"
      }
    }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 缺省按序号生成 `server-<n>` |
| `name` | 否 | 缺省 `模板 <n>` |
| `category` | 否 | 抽屉里的分类页签，缺省取 `tag` 再退到 `其他` |
| `prompt` | 是 | 应用到输入框的提示词 |
| `preview` | 否 | 相对 `templates.json` 的路径，也接受 `http(s)://` 与 `data:`；缺省不显示预览 |
| `params.size` | 否 | 必须形如 `1024x1024`，否则退到 `1024x1024` |
| `params.count` | 否 | 也接受 `params.n`，都缺省为 1 |

`preview` 的相对路径是相对 `templates.json` 所在目录解析的，不是站点根目录 —— 写 `previews/x.webp` 而不是 `/imagegen-assets/previews/x.webp`。

## 缓存

前端把拉到的清单缓存在浏览器 localStorage（键 `imgGenTemplateCatalogCache`，版本 2），并按目录 URL 校验。断了后端也能打开抽屉，但拿到的是上次缓存。

- 改模板内容：刷新页面即可（JSON 走 `no-cache`）。
- 换预览图但文件名不变：浏览器可能吃 1 小时缓存，换文件名最稳。
- 本地缓存结构变了要把 `CATALOG_CACHE_VERSION` 加一，否则旧缓存继续生效。
