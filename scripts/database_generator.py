import os
import json
import re
from bs4 import BeautifulSoup, NavigableString, Tag

def to_markdown(node):
    if isinstance(node, NavigableString):
        text = str(node).replace('¶', '')
        if text.isspace() and '\n' in text:
            return ' '
        return text

    if not isinstance(node, Tag):
        return ''

    # Ignore anchor links for the table of contents (¶)
    if node.name == 'a' and 'toc-anchor' in node.get('class', []):
        return ''

    # Bold text
    if node.name in ['strong', 'b']:
        return f"**{get_inner_markdown(node).strip()}**"
    
    # Italic text
    if node.name in ['em', 'i']:
        return f"*{get_inner_markdown(node).strip()}*"
    
    # Mono text
    if node.name == 'code':
        return f"`{get_inner_markdown(node).strip()}`"
    
    # Code blocks
    if node.name == 'pre':
        return f"\n```gcode\n{node.get_text().strip()}\n```\n"
    
    # Headings
    if node.name in ['h3', 'h4', 'h5', 'h6']:
        level = int(node.name[1])
        prefix = '#' * level
        text = get_inner_markdown(node).strip()
        return f"\n{prefix} {text}\n\n"
    
    # Paragraphs
    if node.name == 'p':
        return f"\n{get_inner_markdown(node).strip()}\n"
    
    # List items
    if node.name == 'li':
        return f"- {get_inner_markdown(node).strip()}\n"
    
    # Lists (add spacing around)
    if node.name in ['ul', 'ol']:
        return f"\n{get_inner_markdown(node)}\n"
    
    if node.name == 'br':
        return "\n"
    
    # Working with tabs (tabset) in Vue.js
    if node.name == 'tabset':
        result = ""
        tabs_container = node.find('div', attrs={"v-slot:tabs": ""})
        tab_names = [li.get_text(strip=True) for li in tabs_container.find_all('li')] if tabs_container else []
        
        panels = node.find_all(class_='tabset-panel')
        for i, panel in enumerate(panels):
            tab_name = tab_names[i] if i < len(tab_names) else f"Option {i+1}"
            result += f"\n### [{tab_name}]\n"
            result += get_inner_markdown(panel)
            result += "\n---\n" # Tab separator
        return result

    # For other tags (div, span, etc.)
    return get_inner_markdown(node)

def get_inner_markdown(node):
    return "".join(to_markdown(child) for child in node.children)

def generate_lsp_database():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_path = os.path.join(script_dir, '../server/data/gcode-commands.json')
    
    html_path = os.path.join(script_dir, 'Gcodes.html')
    html_fallback_path = os.path.join(script_dir, 'Gcodes')

    print("Loading HTML file...")
    
    try:
        with open(html_path, 'r', encoding='utf-8') as f:
            html_content = f.read()
    except FileNotFoundError:
        with open(html_fallback_path, 'r', encoding='utf-8') as f:
            html_content = f.read()

    html_content = html_content.replace('<template', '<div').replace('</template>', '</div>')

    print("Parsing HTML...")
    soup = BeautifulSoup(html_content, 'html.parser')
    lsp_database = {}

    command_pattern = re.compile(r'^([GMT](?:\d+(?:\.\d+)?)?):\s*(.*)')

    print("Compiling the database...")
    
    for heading in soup.find_all(['h2', 'h3']):
        element_id = heading.get('id')
        if not element_id:
            continue
            
        header_text = heading.get_text(strip=True).replace('¶', '').strip()
        
        match = command_pattern.match(header_text)
        if not match:
            continue
            
        code = match.group(1).upper()
        title = match.group(2).strip()
        anchor = f"#{element_id}"
        
        description_parts = []
        current = heading.next_sibling
        
        while current:
            if current.name in ['h1', 'h2']:
                break
            
            if current.name == 'h3':
                next_text = current.get_text(strip=True).replace('¶', '').strip()
                if command_pattern.match(next_text):
                    break
            
            md_text = to_markdown(current)
            if md_text.strip():
                description_parts.append(md_text)

            current = current.next_sibling

        raw_description = ''.join(description_parts)
        description = re.sub(r'\n{3,}', '\n\n', raw_description).strip()

        lsp_database[code] = {
            "title": title,
            "description": description,
            "anchor": anchor
        }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(lsp_database, f, ensure_ascii=False, indent=2)

    print(f"Success! The database has been saved to '{output_path}'")
    print(f"Commands processed: {len(lsp_database)}")

if __name__ == "__main__":
    generate_lsp_database()