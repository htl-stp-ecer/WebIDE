interface Step {
  name: string;
  import: string;

  arguments: {
    name: string;
    type: string;
    import: string | null;
    optional: boolean;
    default: string | null;
  }[]

  file: string;
}
