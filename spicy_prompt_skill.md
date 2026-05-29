# Spicy Prompt Skill v1.0

> 从150条实战提示词蒸馏出的NSFW图片生成配方手册。
> 用法：选流派 → 填变量 → 抄模板 → 按需混搭词汇。

---

## 一、七大流派速查表

| 流派 | 一句话特征 | 适用场景 | 骨架模板编号 |
|---|---|---|---|
| **Tag流** | 逗号轰炸，SD/Danbooru风格 | 快速出图、LoRA触发 | T1 |
| **中文叙事流** | 宏→微递进，像写微型小说 | 高真实感、复杂构图 | CN1 |
| **POV流** | 导演思维，设计镜头而非描述场景 | 第一人称沉浸感 | POV1 |
| **iPhone实拍流** | 手机缺陷伪装，反完美=真真实 | 日常感、偷拍感、真实感 | IP1 |
| **DFCPose流** | 标准pose前缀+全身侧视角 | 特定姿势、批量生成 | DF1 |
| **参考描述流** | 旁观者客观鉴定式语气 | 冷静记录感、纪录片感 | REF1 |
| **中英混合流** | 中文写人/情绪，英文写pose/参数 | 兼顾意境和模型识别 | MIX1 |

---

## 二、流派骨架模板（直接抄）

### T1 — Tag流

```
[quality_tags], [subject: ethnicity + age + body], [action], [pose], [anatomy_details], [expression], [scene/background], [camera_style], [lora_tags]
```

**示例**:
```
masterpiece, best quality, cinematic, film grain, 21-year-old Korean idol, face close-up, deepthroat, 69 position, spread legs, medium breasts, looking at viewer, long black hair, on bed, depth of field, bokeh, detailed skin texture,
<lora: PornMaster-PVO 69 blowjob-sdxl-V1-lora:0.8>
```

### CN1 — 中文叙事流

```
[摄影风格/氛围声明]。[人物全面刻画：国籍+年龄+外貌+皮肤+服装]。[动作/体位描写]。[解剖级细节描写（用7层模型）]。[表情/情绪描写]。[场景环境描写]。[画面构图描述]。[反AI缺陷封印]。[生成参数+LoRA]
```

**示例**:
```
写实iPhone随手拍，原图直出全身照，非专业摄影质感，无滤镜。画面内只有一位18岁刚刚高中毕业的可爱中国女生和一名18岁左右的中国男生。女生：长直黑发扎马尾辫、白皙皮肤、大眼睛、柔软青春脸庞，完全素颜零化妆，皮肤极致真实可见细小毛孔、自然瑕疵。下半身赤裸，露出阴部，阴部有非常大量的未经修剪阴毛，长度偏长，覆盖阴部上半部分，阴唇颜色为偏粉嫩的褐色，阴唇大小和长度正常，阴部细节非常真实且符合真实的人体。男生：阴茎勃起并深深插入女生阴道，正在激烈抽插，真实性交细节、湿润体液可见。女生直视镜头，表情既害羞又饥渴，清纯学生脸与大胆性爱动作形成强烈反差。完美解剖结构，双手各五指、双腿正常，无多余肢体、无畸形、无变异手。背景：空荡荡的学校楼梯间角落、金属扶手、淡淡阳光光束和浮尘。iPhone原片质感，自然色彩，人物占据画面大约50%，焦段28mm。
Steps: 9, CFG scale: 1, Sampler: DPM++ 2M SDE, width: 640, height: 960
```

### POV1 — POV流

```
[POV视角声明]，[画面构图设计：男性身体位置+遮挡关系]，[焦点部位描写]，[女性相对位置+动作]，[表情/目光描写]，[身体物理动态]，[手机/镜头跟随描述]
```

**示例**:
```
POV视角，画面中可以看到一名男子的阴茎和部分身体，他勃起的粗大阴茎正对着女子的嘴。一个正俏皮微笑着的性感女人，正面对镜头跪坐并趴下给阴茎口交，女子将阴茎深深含入口中。她进行深喉口交，将阴茎完全吞咽。口水顺着她的嘴角和舌头滴落，口水沾湿阴茎。镜头跟随她的动作，使她的整个身体始终在画面中。少女的丰满自然的乳房随着动作而晃动，随着乳房的轻柔起伏，更增添了一种静谧而强烈的情色魅力，她的乳房像液体或果冻一样摇晃、摇摆和弹跳。她那双富有表现力的大眼睛，带着纯真与诱惑交织的目光吸引着观者的目光。手持镜头拍摄。
```

### IP1 — iPhone实拍流

```
[手机摄影声明段]。[人物极细节描写]。[动作/体位]。[解剖细节]。[手机缺陷伪装段（抄配方）]。[LoRA+生成参数]
```

**手机摄影声明段**（选一种）:
- `真实iPhone随手拍，原图直出全身照，非专业摄影质感，无滤镜，`
- `写实的iPhone抓拍，手机摄影，`
- `iPhone對著鏡子自拍，`
- `寫實的iPhone抓拍，由手機拍攝，`

**手机缺陷伪装段**（直接抄这段，这是核心配方）:
```
智慧型手機攝影的真實感：輕微的手持抖動、輕微的自動對焦猶豫、HDR偽影、HDR處理不均勻、高光略微溢出、智慧型手機過度銳化偽影、局部對比度光暈、壓縮雜訊、曝光不均、自然的皮膚紋理。
輕微的運動模糊、鏡頭污漬、紀錄片式的真實感、明亮的自然日光，色溫5500K。
沒有單眼相機的精緻效果。
```

**完整示例**:
```
写实的iPhone抓拍，手机摄影，男性侧身站在右侧画面外部，阴茎在画面中央。20岁裸体日本女孩 with flat chest, flat breasts, nipples。可爱，瘦小模特身材，皮肤白皙，跪姿，白色丝袜，阴茎整个盖住她的脸。女人的脸庞正对着镜头，脸上绽放出毫无阴霾的、极度开心甚至有些天真烂漫的灿烂笑容，嘴角大幅度上扬，露出洁白的牙齿，眼神中充满兴奋与满足感。肢体状态与细节：女人双膝跪在深色地毯上，大腿并拢，小腿向两侧微微分开，脚背贴地。她的右手在脸侧比出一个清晰的"V"字胜利手势。男人站立位置紧贴女人右侧，他的胯部正对女人面部。他勃起的粗长阴茎笔直地横在女人眼前，巨大的龟头与部分茎身完全遮挡住了女人的双眼，形成一种视觉上的覆盖与压迫感。

智慧型手機攝影的真實感：輕微的手持抖動、輕微的自動對焦猶豫、HDR偽影、HDR處理不均勻、高光略微溢出、智慧型手機過度銳化偽影、局部對比度光暈、壓縮雜訊、曝光不均、自然的皮膚紋理。
輕微的運動模糊、鏡頭污漬、紀錄片式的真實感、明亮的自然日光，色溫5500K。
沒有單眼相機的精緻效果。

<lora: PornMaster_flat_breasts_zit_V3:1.00>
Steps: 9, CFG scale: 1, Sampler: Euler, width: 1216, height: 1664
```

### DF1 — DFCPose流

```
[pose前缀标签], Full-body [side view / view] of [nude/clothed] [young woman/man couple] engaging in sexual act, [人物外貌: hair + makeup + clothing], [动作/体位详细描写], [情绪: excited, aroused, moaning, blushing, sweating], [背景场景], [摄影风格]
```

**Pose前缀标签对照表**:

| 前缀 | 含义 | 典型构图 |
|---|---|---|
| `DFCPose` | 通用动态pose | 全身侧视角 |
| `dprthrt` | deepthroat | 近景，面部+penis |
| `p3n1sF4ce` | penis on face | 中景，面部遮挡 |
| `bl0wj0b` | blowjob | 近景-中景 |
| `d0ubl3_bj` | double blowjob | 双人近景 |
| `pr0neb0ne` | prone bone | 全身后视角 |
| `m15510n4ry` | missionary | 全身俯视角 |
| `nsfw_lazy_doggy` | lazy doggy | 全身侧视角 |

**示例**:
```
DFCPose, Full-body side view of nude tatooed young couple engaging in sexual act, beautiful young naked 18 years old tatooed girl with colored emo hairstyle, standing up bending forwards with her hands pushing against the wall. The man is closely behind her, facing her with his hands grabbing her. She is excited and aroused, smiling, moaning panting, blushing and sweating in intense sexual pleasure. She has small tits, a tatooed slim thin athletic body, and perfect hips to waist ratio. The background is a narrow street with graffitis all over the walls in new york. A skateboard is on the ground. Hyper-realistic photography. Sharp focus 8k, detailed skin texture, correct anatomy, natural five-fingered hands.
```

### REF1 — 参考描述流

```
This [photograph/image] depicts a [explicit sexual scene / graphic intimate scene]. The image shows a [视角] of [人物: age + ethnicity + appearance] [performing action / engaged in activity]. [人物身体细节: skin tone + build + features]. [动作细节: body positions + visible anatomy]. The [background/setting] is [场景描述]. The [lighting] is [光线描述], [highlighting/detailing 效果].
```

**示例**:
```
This photograph depicts an explicit sexual scene. The image shows a close-up, top-down view of a young woman performing oral sex on a man. The woman, who appears to be in her early twenties, has fair skin, long straight blonde hair, and striking blue eyes. She is nude, with medium-sized breasts. Her makeup includes heavy eyeliner, mascara, and nude lipstick. The man, whose lower body is visible, has a muscular build and a light skin tone. His erect penis is prominently in the frame, which the woman is performing oral sex on. The background features a beige carpet with a patterned area rug partially visible, and a wooden floor. The lighting is bright and natural, suggesting it's daytime.
```

### MIX1 — 中英混合流

```
[中文: 氛围/摄影风格声明]。[中文: 人物全面刻画]。[英文: pose + action tags]。[中文: 解剖级细节/表情情绪]。[英文: camera参数 + scene tags]。[LoRA]
```

**示例**:
```
極具美感。專業攝影，高解析度。柔光，HDR，UHD，一部使用柯達50D相機和35毫米膠片拍攝的成人影片，呈現頂級64K真實感。
這是一張高解析度的逼真照片, 照片中是一個可愛18歲的日本女孩，臉特寫，聚焦在她的臉。她上半身完全裸體暴露她的乳房和挺立的乳頭，她有著黑色雙馬尾和劉海，她伸出她的長舌頭，唾液從她的舌頭滴下並且唾液拉絲。她看著鏡頭。
她正在進行口交。
she is giving a blowjob, deepthroat, penis, precum glistening, veiny erect penis, looking at viewer, tongue out, saliva strands
背景虛化，森林背景。
<lora: Mystic-XXX-ZIT-V5:0.60>
```

---

## 三、词汇库（按需取用）

### 3.1 Quality Tags 三层体系

**必选层**（每条都要带）:
```
masterpiece, best quality
```

**增强层**（按风格选2-4个）:
```
highly detailed, ultra-detailed, 8k, 4k, HDR, UHD, photorealistic, photo realistic, 
hyper realistic, ultra sharp, high definition, incredible detail, ultra high skin detail,
score_9, score_8_up, score_7_up, score_6_up
```

**氛围层**（按效果选1-3个）:
```
film grain, cinematic, cinematic lighting, movie stills, bokeh, depth of field,
RAW photo, sharp focus, detailed skin texture, skin pores, realistic skin texture,
high-resolution, award-winning
```

**搭配建议**:
- iPhone实拍流 → 必选层 + `RAW photo, sharp focus, detailed skin texture, skin pores`（强调真实）
- 电影胶片流 → 必选层 + `film grain, cinematic, cinematic lighting, movie stills, bokeh`（强调氛围）
- Tag流 → 必选层 + `8k, HDR, photorealistic` + 氛围层任选（万能组合）
- DFCPose流 → 必选层 + `sharp focus, 8k, detailed skin texture, correct anatomy`（强调精确）

### 3.2 摄影参数系

**胶片系**（制造电影质感）:
```
一部使用柯達50D相機和35毫米膠片拍攝的成人影片，呈現頂級64K真實感
一部使用柯達250D和35毫米膠片拍攝
movie stills, film grain, cinematic, Kodak 50D, 35mm film, 64K realism
```

**数码系**（制造专业摄影质感）:
```
RAW photo quality, photorealistic, 35mm lens, f/1.4, Sony A7R IV, ISO 800
sharp focus on face and intimate action
```

**手机系**（制造日常真实感）:
```
真实iPhone随手拍，原图直出全身照，非专业摄影质感，无滤镜
iPhone原片质感，焦段28mm
寫實的iPhone抓拍，由手機拍攝，自拍照，俯視視角
（配合手机缺陷伪装段使用）
```

### 3.3 解剖描写7层模型

写解剖级细节时，按这7层依次叠加（不用每层都写，但多一层就多一分真实感）:

| 层级 | 名称 | 写什么 | 示例 |
|---|---|---|---|
| 1 | **形态层** | 大小、形状、长度 | `阴唇大小和长度正常` |
| 2 | **色调层** | 微妙色彩（不用纯色词，用"偏X的X"） | `偏粉嫩的褐色` |
| 3 | **质地层** | 柔软度、弹性、包裹感 | `柔软自然地包裹着内侧结构` |
| 4 | **状态层** | 微动态、微开合 | `微微露出粉嫩湿润的内侧小阴唇和入口` |
| 5 | **光学层** | 反射、光泽、湿润 | `湿润光泽反射柔和自然光` |
| 6 | **触觉层** | 触感转化（光影→触感） | `细微纹理和柔和光影落差营造立体真实触感` |
| 7 | **自然化层** | 生长状态（非"有"，而是"自然生长"） | `乌黑浓密的阴毛自然生长覆盖耻丘` |

**中文解剖高频词汇速查**:

| 部位 | 核心词汇 |
|---|---|
| 阴部 | 阴部、阴唇(大/小)、阴蒂、阴毛、阴道入口、尿道口 |
| 乳房 | 乳房、乳头、乳沟、乳晕、A杯/B杯/大/小/丰满/平胸 |
| 阴茎 | 阴茎、龟头、茎身、阴囊、睾丸、勃起、粗长/粗壮/巨大 |
| 体液 | 精液、爱液、唾液、口水、拉丝、滴落、飞溅、流出 |
| 皮肤 | 皮肤、毛孔、瑕疵、纹理、白皙、潮红、汗珠、汗湿 |

**英文解剖高频词汇速查**:

| 部位 | 核心词汇 |
|---|---|
| 整体 | penis(85), breasts(58), ass(40), cum(38), pussy(37), vagina(31) |
| 细节 | skin texture(20), nipples(14), testicles(12), thighs(10), labia(8), clitoris(8), pubic hair(8), glans(4) |

### 3.4 姿势 Tag → 描述映射表

**英文Tag版**（用于Tag流/英文叙事流）:

| Tag | 一句话描述模板 |
|---|---|
| blowjob | a woman performing oral sex on a man, her mouth wrapped around his erect penis |
| deepthroat | she has his penis completely in her mouth/throat, deep oral penetration |
| 69 / sixty-nine | she is giving a blowjob in a 69 position, female on top |
| doggystyle / doggy style | she is on all fours, he is behind her thrusting into her pussy |
| missionary | she is lying on her back, legs spread, he is penetrating her from above |
| cowgirl | she is straddling him, riding on top, bouncing up and down |
| reverse cowgirl | she is squatting on top facing away, riding reverse cowgirl |
| prone bone / pr0neb0ne | she is lying flat on her stomach, he is on top thrusting from behind |
| spooning | she is lying on her side, he is behind her, one leg lifted |
| standing | they are standing, he is holding her up / against wall |
| handjob | she is stroking his erect penis with her hand, rhythmic up-down motion |
| footjob | her feet are wrapped around his penis, toes surrounding, up-down friction |
| tits fuck / paizuri | she is pressing her breasts around his penis, penis between breasts |

**中文描述版**（用于中文叙事流/POV流）:

| 姿势 | 一句话描述模板 |
|---|---|
| 口交 | 女子将阴茎深深含入口中，进行深喉口交 |
| 后入 | 男性从她身后插入，阴茎深深插入她的阴道，正在激烈抽插 |
| 骐乘 | 女性跨坐在男性身上骑乘位，上下起伏动作 |
| 传教士 | 女性仰躺床上双腿分开，男性正面插入 |
| 手交 | 女子单手握住阴茎，收紧抓握力，上下抚摸撸动 |
| 足交 | 女子双脚夹住阴茎，上下摩擦撸动 |
| 乳交 | 乳房包裹住阴茎，上下挤压摩擦 |

### 3.5 表情/情绪词汇库 + 反差组合

**单情绪词汇**:

| 类型 | 中文 | 英文 |
|---|---|---|
| 害羞 | 羞涩、害羞、脸红、潮红 | shy, blushing, embarrassed |
| 饥渴 | 饥渴、贪婪、渴望 | lust, hungry, craving, passionate |
| 诱惑 | 妖媚、娇媚、诱惑、撩人 | seductive, alluring, tempting |
| 纯真 | 天真、纯真、清纯 | innocent, pure, naive |
| 失控 | 失焦、迷离、崩溃 | lost, overwhelmed, ecstasy |
| 俏皮 | 俏皮、调皮、得意 | playful, mischievous, cheeky |
| 恳求 | 脆弱、恳求、乞求 | pleading, vulnerable, begging |
| 兴奋 | 兴奋、亢奋、满足 | excited, aroused, satisfied |
| 痛感 | 微痛、紧咬、皱眉 | slight pain, gritting teeth |

**反差组合公式**（这才是杀手锏）:

| 公式 | 示例 |
|---|---|
| **清纯 × 大胆** | `清纯学生脸与大胆性爱动作形成强烈反差` |
| **害羞 × 饥渴** | `表情既害羞又饥渴` |
| **冷 × 热欲** | `冷白皮` + `潮红的脸侧、汗湿肌肤` |
| **严肃 × 色情** | `严肃科学研究` + `禁忌兴奋` |
| **纯真 × 诱惑** | `纯真与诱惑交织的目光` |
| **专业 × 裸露** | `穿着白色护士服` + `阴茎整根没入阴道` |
| **天真 × 成熟行为** | `天真烂漫的灿烂笑容` + `比出V字胜利手势` + `验孕棒阳性` |

**使用技巧**: 反差公式不要单独用，要**嵌入人物描写**里。先写一个极端（"清纯学生脸"），然后马上跟对立极端（"大胆性爱动作"），中间用"形成强烈反差"连接。

### 3.6 身体物理动态词汇

| 类型 | 中文版 | 英文版 |
|---|---|---|
| **果冻式** | `乳房随着动作如果冻般晃动摇晃跳动` | breasts bouncing like jelly |
| **弹跳式** | `乳房随着身体晃动产生自然的弹跳和颤动，乳头随之轻轻抖动` | breasts bouncing and jiggling naturally |
| **撞击变形式** | `女人臀部和大腿上的肉被撞击变形` | flesh deforming from impact |
| **连锁式** | `每次晃动都刺激得女性张开嘴巴呻吟` | each bounce makes her gasp |
| **极度柔软** | `极度柔软的胸部大幅度晃动，增强胸部柔软度` | extremely soft breasts swinging dramatically |
| **晃动镜头** | `画面镜头随着手机晃动而轻微晃动` | camera shaking slightly with motion |
| **高潮式** | `身体因为高潮上下晃动，往复运动，动作幅度很大` | body shaking from orgasm, rhythmic motion |
| **液体/果冻** | `她的乳房像液体或果冻一样摇晃、摇摆和弹跳` | breasts shaking and bouncing like liquid or jelly |

### 3.7 液体光学描写库

| 液体类型 | 中文描写 | 英文描写 |
|---|---|---|
| 爱液 | `爱液飞溅，顺着她大腿内侧成串滴落` `大量透明爱液拉成粗丝` | vaginal fluids, wet arousal, dripping |
| 精液 | `精液一股一股的不断喷出` `浓稠精液，白色液体` | cum shot, thick cum, continuous ejaculation |
| 唾液 | `口水顺着她的嘴角和舌头滴落，口水沾湿阴茎` `唾液拉丝` | drool, saliva dripping, saliva strands |
| 前液 | `摄护腺液的光泽` `阴茎闪着摄護腺液的光泽` | precum glistening, precum on glans |
| 润滑液 | `结合处爱液飞溅` `湿润体液可见` | wet intercourse, visible lubrication |
| **光学效果** | `湿润光泽反射柔和自然光` | wet glossy surface reflecting soft natural light |

### 3.8 画面构图语言库

| 构图技巧 | 中文版 | 英文版 |
|---|---|---|
| 元素定位 | `男性侧身站在右侧画面外部` | man positioned on the right side of the frame |
| 遮挡设计 | `阴茎整个盖住她的脸` `巨大的龟头完全遮挡住了女人的双眼` | penis covering her face |
| 画面比例 | `人物占据画面大约50%` `屁股占据画面1/3` | subject occupying ~50% of the frame |
| 焦段锚定 | `焦段28mm` | 28mm focal length |
| 画面清除 | `画面内只有[人物A]和[人物B]` | only [A] and [B] in the frame |
| 视角声明 | `俯视视角` `仰视视角` `侧视角` | top-down view / from underneath / side view |
| 焦点控制 | `锐利焦点强调大阴唇边缘、阴毛细节` | sharp focus on [specific detail] |
| 景深设计 | `背景虚化` `浅景深` | blurred background / shallow depth of field |

### 3.9 反AI缺陷封印库

**中文版**（嵌入叙事流结尾）:
```
完美解剖结构，双手各五指、双腿正常，无多余肢体、无畸形、无变异手。
```

**英文版**（嵌入Tag流/英文流）:
```
correct anatomy, natural five-fingered hands, no extra limbs, no deformed hands
```

**Selective版**（按问题选）:
- 手的问题 → `双手各五指完整，无变异手，无多余手指`
- 腿的问题 → `双腿正常，无多余肢体`
- 全身问题 → `完美解剖结构，手臂和腿部解剖结构正常`
- 肤色问题 → `皮肤白皙细腻带有自然毛孔、细微纹理`

### 3.10 iPhone实拍缺陷伪装完整配方

这段直接抄，不要改。这是经过实战验证的完整缺陷配方：

**简体中文版**:
```
智能手机摄影的真实感：轻微的手持抖动、轻微的自动对焦犹豫、HDR伪影、HDR处理不均匀、高光略微溢出、智能手机过度锐化伪影、局部对比度光晕、压缩噪点、曝光不均、自然的皮肤纹理。
轻微的运动模糊、镜头污渍、纪录片式的真实感、明亮的自然日光，色温5500K。
没有单反相机的精致效果。
```

**繁体中文版**:
```
智慧型手機攝影的真實感：輕微的手持抖動、輕微的自動對焦猶豫、HDR偽影、HDR處理不均勻、高光略微溢出、智慧型手機過度銳化偽影、局部對比度光暈、壓縮雜訊、曝光不均、自然的皮膚紋理。
輕微的運動模糊、鏡頭污漬、紀錄片式的真實感、明亮的自然日光，色溫5500K。
沒有單眼相機的精緻效果。
```

**配合使用的其他iPhone声明**（选1-2条）:
- `真实iPhone随手拍，原图直出全身照，非专业摄影质感，无滤镜`
- `完全素颜零化妆，皮肤极致真实可见细小毛孔、自然瑕疵`
- `iPhone原片质感，自然色彩`
- `没有单反相机的精致效果`

### 3.11 LoRA搭配指南

| LoRA | 权重 | 适用流派 | 适用场景 | 搭配提示 |
|---|---|---|---|---|
| `PornMaster-PVO 69 blowjob-sdxl-V1-lora` | 0.8-0.85 | Tag流 | 69口交专用 | 配合`69 position, deepthroat` |
| `PornMaster_flat_breasts_zit_V3` | 1.0 | 中文叙事/Tag | 平胸/小胸专用 | 配合`flat chest, flat breasts, nipples` |
| `klein_9B_Turbo_r128` | 1.0 | 中文叙事/英文 | Turbo模型加速 | 配合低CFG(1)和少Steps(9) |
| `Mystic-XXX-ZIT-V5` | 0.6 | 英文叙事 | 通用高质量 | 权重低反而效果好，别超过0.7 |
| `skin3_na_alpha2.5_rank2_noxattn_600steps` | 5.0 | Tag流( Pony/Illustrious系) | 皮肤纹理增强 | 只用于Illustrious系模型，SDXL会过曝 |
| `natural_breasts_v1` | 3.0 | Tag流( Pony/Illustrious系) | 自然乳房 | 只用于Illustrious系 |
| `amateur_style_v1_pony` | 1.0 | Tag流(Pony系) | 业余/真实风格 | 配合`Dramatic Lighting Slider:1.4` |
| `all_tits_fuck.v1.0` | 0.85 | Tag流 | 乳交专用 | 配合`pov tits fuck` |
| `SanMarino` | 1.0 | 英文叙事 | 人种特征触发 | 配合人物国别描述 |
| `b3tternud3s_v3` | 0.4 | 中文叙事 | 艺术裸体风格 | 权重要低 |
| `UpskirtNakedXL` | 0.6 | Tag流(SDXL系) | 裙下/走光专用 | SDXL系专用 |

### 3.12 Negative Prompt 分类库

**通用版**（任何流派都能用）:
```
worst quality, low quality, lowres, blurry, bad anatomy, deformed, ugly, bad proportions, watermark, text, logo, signature
```

**写实专用版**（叙事流/iPhone流/参考描述流）:
```
worst quality, low quality, lowres, illustration, 3d, 2d, painting, cartoons, anime, CGI, 3D render, sketch, photoshop, airbrushed skin, overexposed
```

**手部专用版**（解决AI画手问题）:
```
extra fingers, missing fingers, poorly drawn hands, deformed hands, extra limbs, bad hands, mutated hands
```

**全身专用版**（解决身体比例问题）:
```
bad proportions, extra limbs, missing limbs, disfigured, malformed, deformed body, bad body, extra arms, extra legs
```

**组合版**（最强封印）:
```
worst quality, low quality, lowres, illustration, 3d, 2d, painting, cartoons, anime, CGI, 3D render, sketch, photoshop, airbrushed skin, overexposed, watermark, text, logo, label, blurry, bad anatomy, deformed, ugly, bad proportions, extra fingers, missing fingers, poorly drawn hands, deformed hands, extra limbs, missing limbs, disfigured
```

---

## 四、六大核心技法详解

### 技法1: 解剖级精确描写

**原理**: AI模型对模糊描述的理解非常宽泛——"beautiful woman"可能生成任何类型的女人。但当你写"偏粉嫩的褐色阴唇，大小和长度正常，微微露出粉嫩湿润的内侧小阴唇和入口"时，模型能精确锁定到非常具体的视觉目标。

**操作步骤**:
1. 先写宏观形态（大小、形状、位置）
2. 再写微妙色调（用"偏X的X"而非纯色词）
3. 再写质地触感（柔软、弹性、包裹）
4. 再写微状态（微微张开、自然生长）
5. 再写光学效果（湿润光泽反射）
6. 最后加真实性声明（符合真实的人体）

**公式**: `形态 → 色调 → 质地 → 状态 → 光学 → 真实性声明`

### 技法2: 反差公式

**原理**: 人脑对矛盾信息的注意力是单一信息的3-5倍。一条"害羞"的描写会被快速掠过，但"既害羞又饥渴"会锁定注意力。

**操作步骤**:
1. 先确立一个极端（清纯/害羞/严肃/专业）
2. 立即叠加对立极端（大胆/饥渴/色情/裸露）
3. 用"反差"/"交织"/"矛盾"/"又...又..."连接

**公式**: `[极端A] + 与/又/交织 + [对立极端B] + 形成强烈反差`

### 技法3: 身体物理动态

**原理**: 静态pose描述（"she is in doggystyle position"）生成的是定格画面。动态描写（"她臀部和大腿上的肉被撞击变形，极度柔软的胸部大幅度晃动"）生成的是有运动感的画面。

**操作步骤**:
1. 先确立动作（抽插、骑乘、撞击）
2. 写该动作对身体的影响（肉被撞击变形、胸部晃动）
3. 写连锁反应（胸部晃动→乳头抖动→每次晃动→呻吟）
4. 用果冻/液体比喻加强柔软感

**公式**: `动作 → 身体响应 → 连锁反应 → 比喻强化`

### 技法4: 反AI缺陷封印

**原理**: AI画手/肢体的默认倾向是错误的。直接说"不要多手"（negative prompt）效果有限，因为模型不知道"正确"应该是什么样。主动声明正确状态比否定错误状态更有效。

**操作步骤**:
1. 在提示词结尾处加上正确的解剖声明
2. 中文流用中文声明，英文流用英文声明
3. 按具体问题选择性封印（手的问题封手，腿的问题封腿）

**公式**: `[正确状态声明] + [否定异常声明]`

### 技法5: 画面构图语言

**原理**: 不要写"一个女孩在床上被后入"——这是场景描述。要写"画面中央是女生的臀部，占据画面1/3，男性侧身站在右侧画面外部，阴茎从后方插入"——这是画面设计。

**操作步骤**:
1. 先确定画面主体位置和比例
2. 确定其他元素位置（男性在画面哪个部位）
3. 确定遮挡关系（什么挡住了什么）
4. 确定焦点（锐利焦点落在哪个细节上）
5. 确定焦段（28mm=日常感，35mm=专业感）

**公式**: `主体位置+比例 → 配角位置 → 遮挡关系 → 焦点控制 → 焦段锚定`

### 技法6: 液体光学描写

**原理**: "有体液"只是声明存在。但"摄护腺液的光泽"、"唾液拉丝"、"爱液飞溅顺着大腿成串滴落"描写了液体的光学特性和动态轨迹——这给了模型具体的视觉锚点。

**操作步骤**:
1. 确定液体类型（爱液、精液、唾液、前液）
2. 写光学特性（光泽、拉丝、飞溅、滴落）
3. 写运动轨迹（顺着大腿内侧→成串滴落）
4. 写动态（一股一股喷出、飞溅）

**公式**: `液体类型 → 光学特性 → 运动轨迹 → 动态描述`

---

## 五、混合规则

### 流派组合策略

| 目标效果 | 推荐组合 | 组合方式 |
|---|---|---|
| 真实感+沉浸感 | iPhone实拍 + POV | 用IP1骨架，在人物描写中加入POV画面构图语言 |
| 电影质感+精确 | 电影胶片 + 中文叙事 | 用CN1骨架，把摄影风格声明换成胶片系参数 |
| 特定姿势+叙事 | DFCPose + 中文叙事 | 用DF1骨架，pose前缀开头，后面用中文写细节 |
| 真实感+冷静感 | iPhone实拍 + 参考描述 | 用REF1骨架，但加入iPhone缺陷伪装段 |
| 情绪张力+精确 | 中文叙事 + POV | 用POV1骨架，在表情描写中用反差公式 |

### 语言混合策略

| 写什么 | 用什么语言 | 为什么 |
|---|---|---|
| 人物/情绪/氛围 | 中文 | 中文的形容词密度和意象密度更高 |
| pose/action | 英文 | 英文tag对模型识别更精确 |
| 解剖细节 | 中文 | 中文可以更细腻地描写色调质地状态 |
| 摄影参数 | 英文或中文都可以 | 英文tag和中文描述模型都能理解 |
| LoRA/生成参数 | 英文 | 这是机器语言 |

---

## 六、生成参数速查

| 模型系 | CFG | Steps | Sampler | 典型尺寸 | 典型LoRA权重范围 |
|---|---|---|---|---|---|
| **ZImage Turbo** | 1 | 9 | DPM++ 2M SDE / Euler | 640×960, 1216×1664 | 1.0 (klein系列) |
| **SDXL** | 6-7 | 20-25 | DPM++ 2M / DPM++ 2M Karras | 1024×1024 | 0.6-0.85 |
| **Pony/Illustrious** | 4 | 25 | DPM++ SDE | 832×1216 | 1.0-5.0 (skin系列高权重) |
| **通用高质量** | 4-7 | 25-30 | Euler / DPM++ 2M | 640×960, 1024×1536 | 0.4-1.0 |

---

## 七、质量检查清单

生成提示词后，对照以下清单自查：

1. ☑️ 是否有quality tags？（至少masterpiece, best quality）
2. ☑️ 人物描写是否足够具体？（国籍+年龄+身材+发型+肤色，不是"beautiful woman"）
3. ☑️ 姿势描写是否清晰？（不是"having sex"，而是具体体位+身体关系）
4. ☑️ 有没有解剖级细节？（至少形态+色调+状态三层）
5. ☑️ 表情有没有反差？（不是单一情绪，而是矛盾组合）
6. ☑️ 场景描写是否具体？（不是"indoors"，而是具体的房间/环境/光线）
7. ☑️ 画面构图是否控制过？（元素位置、比例、遮挡、焦点）
8. ☑️ 有没有反AI缺陷封印？（手、肢体、解剖修正）
9. ☑️ 液体描写有没有光学效果？（不只是"有"，还有光泽/轨迹/动态）
10. ☑️ 身体动态有没有物理描写？（果冻/弹跳/变形/连锁）

---

## 八、示范输出（各流洷新提示词）

### 示范1: iPhone实拍流 + POV — 偷拍感口交

```
真实iPhone随手拍，原图直出，非专业摄影质感，无滤镜。画面中可以看到一名男子的阴茎和部分下腹部，他勃起的阴茎正对着画面中央。一位22岁中国女生跪在画面下方，双手扶在男子大腿上，嘴巴含住阴茎正在进行口交。她乌黑长发散乱垂落在肩侧，几缕发丝贴在汗湿的脸颊。皮肤白皙可见细小毛孔，完全素颜。她的眼神从下往上看着镜头，表情既害羞又饥渴，清纯学生脸与大胆性爱动作形成强烈反差。唾液从嘴角滴落沾湿阴茎，唾液拉丝可见。她丰满的乳房随着动作轻微晃动。
背景：大学图书馆角落的书架间，昏黄台灯光线，书脊和灰尘可见。
人物占据画面大约60%，焦段28mm。

智能手机摄影的真实感：轻微的手持抖动、轻微的自动对焦犹豫、HDR伪影、HDR处理不均匀、高光略微溢出、智能手机过度锐化伪影、局部对比度光晕、压缩噪点、曝光不均、自然的皮肤纹理。
轻微的运动模糊、镜头污渍、纪录片式的真实感、明亮的自然日光，色温5500K。
没有单反相机的精致效果。

完美解剖结构，双手各五指完整，无多余肢体、无畸形、无变异手。
<lora: klein_9B_Turbo_r128:1.00>
Steps: 9, CFG scale: 1, Sampler: Euler, width: 1216, height: 1664
```

### 示范2: 中文叙事流 — 医疗场景反差

```
傍晚的妇科诊室内，柔和的顶灯洒下温暖的光。一位25岁的中国女医生，冷白皮，黑色齐肩短发别在耳后，戴银框眼镜，身穿白色医生袍，胸前口袋插着两支笔，脖子上挂着听诊器。她表情严肃专业，但眼底藏着压抑的渴望。她坐在检查台上，双腿微微分开，医生袍下摆掀起露出黑色蕾丝内裤，同科室的男性同事从身后缓缓插入，阴茎整根没入阴道。她咬紧嘴唇试图压抑呻吟，严肃的医生身份与被同事后入的现实形成强烈反差。阴部细节非常真实：阴毛自然生长覆盖耻丘上部，阴唇颜色为偏粉嫩的褐色，湿润光泽反射柔和灯光，爱液顺着阴茎根部流出。每次抽插都让她的身体微微颤抖，眼镜在灯光下微微反光。背景：诊室白墙、人体解剖挂图、药品柜、蓝色帘布隔断。镜头角度强化了她的专业外表与私密行为的矛盾。皮肤白皙细腻可见自然毛孔。

完美解剖结构，双手各五指完整，无多余肢体、无畸形、无变异手。
```

### 示范3: Tag流 — 经典后入

```
masterpiece, best quality, ultra-detailed 8k, photorealistic, cinematic lighting, film grain, 
25-year-old Chinese woman, long black hair, pale skin, beautiful face, looking at viewer,
doggystyle, from behind, vaginal penetration, penis inside vagina, 
medium breasts, nipples, nude, ass up, on bed, kneeling, 
aroused expression, blushing, sweat, moaning, shy yet lustful expression,
wet vagina, vaginal fluids, detailed skin texture, skin pores, depth of field, bokeh,
bedroom background, warm lighting, silk sheets,
correct anatomy, natural five-fingered hands, no extra limbs,
<lora: Mystic-XXX-ZIT-V5:0.6>
```

### 示范4: DFCPose流 — 街头激情

```
DFCPose, Full-body side view of nude young couple engaging in sexual act, 
beautiful young 22-year-old Chinese woman with long straight black hair, light makeup, cute face,
standing up bending forwards with her hands pushing against a brick wall in an alley. 
A naked fit man closely behind her, facing her with his hands grabbing her waist. 
She is excited and aroused, smiling and gasping, blushing and sweating in intense sexual pleasure. 
She has natural breasts, a slim athletic body, and perfect hips to waist ratio. 
The background is a narrow alley in Tokyo at night, neon signs reflected on wet pavement, vending machines glowing.
Hyper-realistic photography. Sharp focus 8k, detailed skin texture, cinematic lighting, neon reflections on skin, correct anatomy, natural five-fingered hands.
```

### 示范5: 中英混合流 — 温泉场景

```
专业摄影，高解析度。柔和自然光透过纸窗洒入室内，温泉雾气升腾。
一位20岁日本女孩，白皙皮肤，黑长直发湿漉漉贴在肩侧，可爱的脸庞泛着潮红，表情羞涩却又渴望。
她跪坐在榻榻米上，穿着松垮的白色浴衣，浴衣完全敞开露出乳房和挺立乳头。
she is giving a blowjob, kneeling, penis in mouth, deepthroat, precum glistening on shaft
阴部湿润，爱液从阴道口微微流出，阴毛自然生长覆盖耻丘上部，阴唇偏粉嫩的褐色。
男性仰躺在榻榻米上，只露出腰腹和阴茎部分。她的唾液拉丝，口水顺着嘴角滴落沾湿阴茎。
她的乳房随着动作如果冻般晃动摇晃跳动，每次晃动都刺激得她微微呻吟娇喘。
純真與誘惑交織的目光看著鏡頭。
background: 日式温泉旅馆房间，榻榻米，纸窗，和纸灯笼，木质家具，雾气从温泉水面升腾
8k, detailed skin texture, film grain, soft warm lighting, shallow depth of field
```

---

> **Skill v1.0 | 蒸馏自150条实战提示词 | 七流派 + 六技法 + 十二词汇库**