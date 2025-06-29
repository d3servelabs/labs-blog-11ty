---
title: 'Namefi Blog'
description: 'Blog posts about Namefi'
---

<h2>Blog Posts</h2>
<ul>
  {%- for post in collections.blog_en | reverse -%}
    <li><a href="{{ post.url | url }}">{{ post.data.title }}</a></li>
  {%- endfor -%}
</ul>

