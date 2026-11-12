# 定时自动抓取（默认一天 4 次）

## 怎么做

灵感不是从网站抄来的，也不是爬虫抓的：它是模型根据已知的真实海外产品
（如 Gartic Phone / BeReal / Yuka / Splitwise 等）生成的中文点子，每条
都要点名海外原型、写清为什么推荐、并附风险。生成前读库里全部标题去重，
生成后按标题归一化再去重一次；每批至少 5 条点名海外原型、至少 6 条通过
校验才入库，否则整批丢弃。

没有配模型 API 时，`scripts/fetch.js` 只在 `fetch_tasks` 表里记一条
`skipped_no_api` 任务（连同完整提示词一起保存），不入库、不编造灵感。

## cron（NAS / 服务器，默认一天 4 次：02:00、08:00、14:00、20:00）

```cron
0 2,8,14,20 * * * cd /path/to/wechat-mini-program-inspiration-library && /usr/bin/node scripts/fetch.js >> data/fetch.log 2>&1
```

只想在到时间才跑（配合 `FETCH_TIMES_PER_DAY`）时，先判断再跑：

```cron
0 * * * * cd /path/to/wechat-mini-program-inspiration-library && /usr/bin/node scripts/fetch.js --check-due && /usr/bin/node scripts/fetch.js >> data/fetch.log 2>&1
```

## 青龙面板

新建定时任务，命令填 `node scripts/fetch.js`，定时规则填
`0 2,8,14,20 * * *`（一天 4 次），工作目录填项目目录。

## 改频率

- 页面「定时抓取设置」里改「一天抓几次」「每批抓几个」，或改环境变量
  `FETCH_TIMES_PER_DAY` / `FETCH_BATCH_SIZE` 后重启。
- 一天 4 次、每批 12 条的话，一天最多新增 48 条灵感；去重后实际新增
  会少一些（重复标题会被跳过）。嫌多就改成一天 2 次、每批 8 条。

## 手动抓取

页面点标题旁小字「获取新灵感」，或右下角 `+` →「获取灵感」，或：

```bash
node scripts/fetch.js
node scripts/fetch.js --dry-run   # 只检查配置，不调模型、不入库
```

抓取记录在页面「抓取记录」里按批次查看，点「只看这批」可单独筛出来。
