---
title: '中文页面'
description: '这是主页的中文版本'
---

<h2>博客文章</h2>
<ul>
  {%- for post in collections.blog_zh | reverse -%}
    <li><a href="{{ post.url }}">{{ post.data.title }}</a></li>
  {%- endfor -%}
</ul>
