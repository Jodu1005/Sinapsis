export interface DirectoryPicker {
  pickDirectory(): Promise<string | null>
}
