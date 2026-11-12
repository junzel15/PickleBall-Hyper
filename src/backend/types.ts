// Database types for supabase/migrations/20261112000000_init.sql.
// (Can be regenerated with `supabase gen types typescript`.)

export type ProfileRow = {
  id: string;
  name: string;
  avatar: Record<string, unknown>;
  age: number | null;
  paddle: string;
  created_at: string;
  updated_at: string;
};

export type MatchRow = {
  id: number;
  user_id: string;
  mode: 'singles' | 'doubles';
  difficulty: 'easy' | 'medium' | 'hard';
  player_score: number;
  ai_score: number;
  won: boolean;
  rallies_won: number;
  longest_rally: number;
  opponent: string | null;
  played_at: string;
};

export type LeaderboardRow = {
  rank: number;
  name: string;
  wins: number;
  played: number;
  best_rally: number;
  is_me: boolean;
};

export type MatchInsert = Omit<MatchRow, 'id' | 'user_id' | 'played_at'> & { played_at?: string };

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Pick<ProfileRow, 'id'> & Partial<Omit<ProfileRow, 'id'>>;
        Update: Partial<Omit<ProfileRow, 'id'>>;
        Relationships: [];
      };
      matches: {
        Row: MatchRow;
        Insert: MatchInsert & { user_id?: string };
        Update: never;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      get_leaderboard: { Args: { max_rows?: number }; Returns: LeaderboardRow[] };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
