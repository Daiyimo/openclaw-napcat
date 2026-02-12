export type OneBotMessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { file: string; url?: string } }
  | { type: "at"; data: { qq: string } }
  | { type: "reply"; data: { id: string } }
  | { type: "record"; data: { file: string; url?: string; text?: string } }
  | { type: "video"; data: { file: string; url?: string } }
  | { type: "json"; data: { data: string } }
  | { type: "forward"; data: { id: string } }
  | { type: "file"; data: { file?: string; file_id?: string; busid?: number; url?: string } }
  | { type: "face"; data: { id: string } };

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
  };
};
