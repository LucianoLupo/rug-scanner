declare module 'evmole' {
  export function functionSelectors(code: string, gas_limit: number): string[];

  export function contractInfo(
    code: string,
    options: {
      selectors?: boolean;
      arguments?: boolean;
      state_mutability?: boolean;
      storage?: boolean;
    },
  ): {
    functions?: Array<{
      selector: string;
      bytecode_offset: number;
      arguments?: string;
      state_mutability?: string;
    }>;
    storage?: Array<{
      slot: string;
      offset: number;
      type: string;
      reads: string[];
      writes: string[];
    }>;
  };
}
