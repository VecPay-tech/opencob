import React from 'react';
import { DocsThemeConfig } from 'nextra-theme-docs';

const config: DocsThemeConfig = {
  logo: <span style={{ fontWeight: 700 }}>🌿 OpenCob</span>,
  project: {
    link: 'https://github.com/mountek/opencob',
  },
  docsRepositoryBase: 'https://github.com/mountek/opencob/tree/main/docs',
  footer: {
    text: '© 2024-2026 OpenCob Contributors. MIT License.',
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="description" content="OpenCob — AI-Powered COBOL Analysis & Modernization" />
      <meta name="og:title" content="OpenCob Documentation" />
    </>
  ),
  sidebar: {
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },
  toc: {
    float: true,
  },
  useNextSeoProps() {
    return { titleTemplate: '%s – OpenCob Docs' };
  },
};

export default config;
