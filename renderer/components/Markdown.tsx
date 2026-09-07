import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 聊天旁白 Markdown 渲染：loop 完成总结等模型输出天然带 md（标题/加粗/列表/表格），
 * 纯文本气泡会显示裸 md 符号。仅 assistant 气泡走这里（ChatPanel）；
 * user 气泡保持纯文本——用户输入不该被赋予 md 语义。
 * 不引 rehype-raw → 原始 HTML 一律不渲染，无注入面；链接强制新窗口。
 * 排版样式见 styles/tokens.css 的 .bloma-md（标题降级、紧凑间距、表格/代码块横向滚动）。
 */
export const Markdown: React.FC<{ text: string }> = ({ text }) => (
  <div className="bloma-md">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  </div>
)
