import type { CardListData, Config, IntegrationUserConfig, ThemeUserConfig } from 'astro-pure/types'

export const theme: ThemeUserConfig = {
  title: 'NeoTechMind',
  author: 'NeoTechMind',
  description: 'NeoTechMind 动态博客与知识库',
  favicon: '/favicon/favicon.ico',
  socialCard: '/images/social-card.png',
  locale: {
    lang: 'zh-CN',
    attrs: 'zh_CN',
    dateLocale: 'zh-CN',
    dateOptions: {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }
  },
  logo: {
    src: '/src/assets/avatar.png',
    alt: 'NeoTechMind'
  },
  titleDelimiter: ' - ',
  prerender: false,
  npmCDN: 'https://cdn.jsdelivr.net/npm',
  head: [],
  customCss: [],
  header: {
    menu: [
      { title: '首页', link: '/' },
      { title: '博客', link: '/blog' },
      { title: '文档', link: '/docs' },
      { title: '后台', link: '/admin' }
    ]
  },
  footer: {
    year: `© ${new Date().getFullYear()}`,
    links: [
      {
        title: '站点说明',
        link: '/terms',
        pos: 2
      }
    ],
    credits: true,
    social: {}
  },
  content: {
    externalLinks: {
      content: ' ↗',
      properties: {
        style: 'user-select:none'
      }
    },
    blogPageSize: 10,
    share: ['x']
  }
}

export const integ: IntegrationUserConfig = {
  links: {
    logbook: [],
    applyTip: [
      { name: 'Name', val: theme.title },
      { name: 'Desc', val: theme.description || 'Null' },
      { name: 'Link', val: 'http://localhost:4321/' },
      { name: 'Avatar', val: 'http://localhost:4321/favicon/favicon.ico' }
    ],
    cacheAvatar: false
  },
  pagefind: false,
  quote: {
    server: 'https://dummyjson.com/quotes/random',
    target: `(data) => (data.quote.length > 80 ? \`\${data.quote.slice(0, 80)}...\` : data.quote || 'Error')`
  },
  typography: {
    class: 'prose text-base',
    blockquoteStyle: 'italic',
    inlineCodeBlockStyle: 'modern'
  },
  mediumZoom: {
    enable: true,
    selector: '.prose .zoomable',
    options: {
      className: 'zoomable'
    }
  },
  waline: {
    enable: false,
    server: '',
    showMeta: false,
    emoji: [],
    additionalConfigs: {
      pageview: false,
      comment: false,
      locale: {
        reaction0: 'Like',
        placeholder: '欢迎留言'
      },
      imageUploader: false
    }
  }
}

export const terms: CardListData = {
  title: '站点说明',
  list: [
    {
      title: 'Privacy Policy',
      link: '/terms/privacy-policy'
    },
    {
      title: 'Terms and Conditions',
      link: '/terms/terms-and-conditions'
    },
    {
      title: 'Copyright',
      link: '/terms/copyright'
    },
    {
      title: 'Disclaimer',
      link: '/terms/disclaimer'
    }
  ]
}

const config = { ...theme, integ } as Config
export default config
