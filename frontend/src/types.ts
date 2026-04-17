export type WeatherPayload = {
  city: string;
  country?: string;
  temp: number;
  feels_like: number;
  condition: string;
  icon: string;
  humidity: number;
  wind: number;
  visibility_km?: number | null;
  pressure?: number | null;
  timestamp?: number;
  tz_offset?: number;
};

export type UiEvent = { type: "weather_card"; payload: WeatherPayload };

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  uiEvents: UiEvent[];
  pending?: boolean;
  status?: string;
  createdAt: number;
};
