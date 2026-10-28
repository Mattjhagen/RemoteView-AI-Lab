"""Original, bundled vector landscape stimuli; no external image requests or metadata."""
SCENES = {
 'Waterfall': '<path d="M0 90L70 25 140 90 225 35 320 95V240H0" fill="#385c4c"/><path d="M100 80H230L255 240H65Z" fill="#454d50"/><path d="M146 80H190L204 210H130Z" fill="#c3e8ef"/><ellipse cx="167" cy="224" rx="100" ry="20" fill="#7bb8c8"/>',
 'Desert dunes': '<circle cx="250" cy="52" r="24" fill="#ffe6a1"/><path d="M0 130Q80 55 190 140T340 120V240H0" fill="#d2a25f"/><path d="M0 190Q100 90 225 190T340 170V240H0" fill="#a76c43"/><path d="M0 235Q110 145 320 225V240H0" fill="#e9c38b"/>',
 'Stone bridge': '<path d="M0 140Q80 90 160 145T320 130V240H0" fill="#477661"/><path d="M145 140L240 240H60Z" fill="#79b6c4"/><path d="M35 125H285V175H224Q162 82 96 175H35Z" fill="#a5a39b"/><path d="M35 122H285" stroke="#d3cfc0" stroke-width="12"/>',
 'Snowy mountain': '<path d="M0 225L85 95 125 144 200 30 320 225Z" fill="#617a8c"/><path d="M146 110L200 30 255 118 214 96 193 114 177 87Z" fill="#ecf4f4"/><path d="M0 230L85 95 120 148 96 134 78 150 68 124Z" fill="#d6e8ed"/><path d="M0 227Q130 200 320 230V240H0" fill="#b5c6c6"/>',
 'Harbor': '<path d="M0 128H320V240H0Z" fill="#588fa9"/><path d="M0 130V72H53V110H88V60H142V130M210 130V90H265V65H320V130" fill="#c4b6a2"/><path d="M30 185H282" stroke="#8a694d" stroke-width="12"/><path d="M75 155H138L126 173H87Z M190 200H255L243 218H201Z" fill="#eee4cc"/><path d="M104 156V96L132 150Z M219 200V147L245 194Z" fill="#f4f1df"/>'}


def candidate_image(title):
    # Identical headers/size/viewBox; no answer marker, title, description, or filename metadata.
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240">'
            '<path fill="#a0becb" d="M0 0H320V240H0Z"/>' + SCENES[title] + '</svg>').encode()
