export type OneBotMessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { file: string; url?: string; subType?: string; image_type?: string } }
  | { type: "at"; data: { qq: string } }
  | { type: "reply"; data: { id: string } }
  | { type: "record"; data: { file: string; url?: string; text?: string; magic?: boolean } }
  | { type: "video"; data: { file: string; url?: string } }
  | { type: "json"; data: { data: string } }
  | { type: "forward"; data: { id: string } }
  | { type: "file"; data: { file?: string; file_id?: string; busid?: number; url?: string } }
  | { type: "face"; data: { id: string } }
  | { type: "share"; data: { url: string; title: string; content?: string; image?: string } }
  | { type: "contact"; data: { type: "qq" | "group"; id: string } }
  | { type: "location"; data: { lat: string; lon: string; title?: string; content?: string } }
  | { type: "music"; data: { type: "qq" | "163" | "xiami" | "kuwo"; id: string } }
  | { type: "shake"; data: {} }
  | { type: "anonymous"; data: { flag: string } }
  | { type: "xml"; data: { data: string } }
  | { type: "cardimage"; data: { file: string; count: number } }
  | { type: "poke"; data: { qq: string } }
  | { type: "gift"; data: { qq: string; id: number } }
  | { type: "markdown"; data: { content: string } }
  | { type: "button"; data: { id: string; content?: string } };

export type OneBotMessage = OneBotMessageSegment[];

export type OneBotEvent = {
  time: number;
  self_id: number;
  post_type: string;
  meta_event_type?: string;
  message_type?: "private" | "group" | "guild";
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  guild_id?: string;
  channel_id?: string;
  target_id?: number;
  notice_type?: string;
  request_type?: string;
  flag?: string;
  message?: OneBotMessage | string;
  raw_message?: string;
  sender?: {
    user_id: number;
    nickname: string;
    card?: string;
    role?: string;
    title?: string;
    age?: number;
    area?: string;
    gender?: "male" | "female" | "unknown";
  };
  // 新增字段
  file?: any;
  user_ids?: number[];
  operator_id?: number;
  duration?: number;
  anonymous?: { flag: string; name: string; id: number };
  role?: "owner" | "admin" | "member";
  comment?: string;
  request?: any;
  honor_type?: string;
  current_nickname?: string;
  status?: any;
  ability?: any;
};
