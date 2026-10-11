export type SiteId = "map" | "dji" | "sniff";

export type TargetSite = {
  id: SiteId;
  name: string;
  description: string;
  url: string;
  hostPattern: string;
};

export const targetSites: TargetSite[] = [
  {
    id: "map",
    name: "江苏大气站",
    description: "泰州市 K+ 小时监测",
    url: "http://61.155.4.60:18080/#/home/map",
    hostPattern: "http://61.155.4.60:18080/*",
  },
  {
    id: "dji",
    name: "大疆司空",
    description: "超标巡查计划 · 填写后人工确认",
    url: "https://fh.dji.com/organization/b9fb201d-b230-433d-a1d5-e47736ca06f0/project/c7ea6bbc-110d-4dc9-ac75-4653ebbbca49#/plan",
    hostPattern: "https://fh.dji.com/*",
  },
  {
    id: "sniff",
    name: "可飞平台",
    description: "巡航 PM2.5 与航线成果",
    url: "https://aai.airins.cn/sniff/HistoryCloud",
    hostPattern: "https://aai.airins.cn/*",
  },
];
