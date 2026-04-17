export interface Project {
  id: string;
  name: string;
  uid: string;
  sheetUrl?: string;
  lastSynced?: string;
  data?: any[];
}

export interface AppState {
  projects: Project[];
  lastUpdated: string;
}
