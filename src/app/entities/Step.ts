interface Step {
  name: string;
  import: string;

  arguments: {
    name: string;
    type: string;
    import: string;
    optional: boolean;
    default: string;
  }[]

  file: string;
}
