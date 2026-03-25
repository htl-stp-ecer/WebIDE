interface Step {
  name: string;
  import: string;
  tags?: string[];
  chain_methods?: {
    name: string;
    arguments: {
      name: string;
      label?: string;
      type: string;
      import: string | null;
      optional: boolean;
      default: string | null;
    }[];
    chain_methods?: any[];
  }[];

  arguments: {
    name: string;
    type: string;
    import: string | null;
    optional: boolean;
    default: string | null;
  }[]

  file: string;
}
