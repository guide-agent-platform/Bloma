import React from 'react'
import { Markdown } from './Markdown'

/** Brevity belongs to the model contract; never hide or truncate user-facing prose. */
export const CompactReply: React.FC<{ text: string }> = ({ text }) => {
  return <Markdown text={text} />
}
